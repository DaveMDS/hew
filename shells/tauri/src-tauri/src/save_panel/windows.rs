//! Windows: the common item dialog (`IFileSaveDialog`) with its own "Save
//! as type" list, and the chosen type's options added under it through
//! `IFileDialogCustomize` — shown only while their type is the chosen one,
//! as the dialog's own type-change event says.

use super::model::{rename_for, result_for, PanelOption, PanelRequest, PanelResult};
use super::PanelAnswer;
use std::cell::Cell;
use std::rc::Rc;
use windows::core::HRESULT;
use windows::core::{implement, Interface, Ref, Result as WinResult, HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{
    FileSaveDialog, IFileDialog, IFileDialogCustomize, IFileDialogEvents, IFileDialogEvents_Impl,
    IFileSaveDialog, IShellItem, CDCS_ENABLEDVISIBLE, CDCS_INACTIVE, FDE_OVERWRITE_RESPONSE,
    FDE_SHAREVIOLATION_RESPONSE, FOS_FORCEFILESYSTEM, FOS_OVERWRITEPROMPT, FOS_STRICTFILETYPES,
    SIGDN_FILESYSPATH,
};

/// The control ids of format `f`'s option `o`: a visual group (label and
/// list) and the control in it.
fn ids(f: usize, o: usize) -> (u32, u32) {
    let group = 1000 + (f as u32) * 100 + (o as u32) * 2;
    (group, group + 1)
}

/// The formats' options, for the event sink to show and hide.
struct Layout {
    /// Per format: per option, whether it is a list (its group hides) or a
    /// checkbox (the control hides).
    kinds: Vec<Vec<bool>>,
    extensions: Vec<String>,
}

impl Layout {
    fn show(&self, customize: &IFileDialogCustomize, chosen: usize) {
        for (f, options) in self.kinds.iter().enumerate() {
            for (o, &is_list) in options.iter().enumerate() {
                let (group, control) = ids(f, o);
                let state = if f == chosen {
                    CDCS_ENABLEDVISIBLE
                } else {
                    CDCS_INACTIVE
                };
                // SAFETY: plain COM calls on the live dialog, on its thread.
                let _ = unsafe {
                    customize.SetControlState(if is_list { group } else { control }, state)
                };
            }
        }
    }
}

#[implement(IFileDialogEvents)]
struct Events {
    layout: Rc<Layout>,
    chosen: Rc<Cell<usize>>,
}

impl IFileDialogEvents_Impl for Events_Impl {
    fn OnFileOk(&self, _: Ref<'_, IFileDialog>) -> WinResult<()> {
        Ok(())
    }
    fn OnFolderChanging(&self, _: Ref<'_, IFileDialog>, _: Ref<'_, IShellItem>) -> WinResult<()> {
        Ok(())
    }
    fn OnFolderChange(&self, _: Ref<'_, IFileDialog>) -> WinResult<()> {
        Ok(())
    }
    fn OnSelectionChange(&self, _: Ref<'_, IFileDialog>) -> WinResult<()> {
        Ok(())
    }
    fn OnShareViolation(
        &self,
        _: Ref<'_, IFileDialog>,
        _: Ref<'_, IShellItem>,
    ) -> WinResult<FDE_SHAREVIOLATION_RESPONSE> {
        Ok(FDE_SHAREVIOLATION_RESPONSE(0))
    }
    /// The "Save as type" list changed: show that type's options and give
    /// the name its extension.
    fn OnTypeChange(&self, dialog: Ref<'_, IFileDialog>) -> WinResult<()> {
        let dialog = dialog.ok()?;
        // SAFETY: COM calls on the live dialog, on its thread; the name's
        // buffer is the caller's to free.
        unsafe {
            let index = dialog.GetFileTypeIndex()? as usize;
            let Some(next) = index
                .checked_sub(1)
                .filter(|&i| i < self.layout.extensions.len())
            else {
                return Ok(());
            };
            let previous = self.chosen.replace(next);
            let customize: IFileDialogCustomize = dialog.cast()?;
            self.layout.show(&customize, next);
            let to = &self.layout.extensions[next];
            dialog.SetDefaultExtension(&HSTRING::from(to.as_str()))?;
            if let Ok(name) = dialog.GetFileName() {
                let current = name.to_string().unwrap_or_default();
                CoTaskMemFree(Some(name.0 as *const _));
                let renamed = rename_for(&current, &self.layout.extensions[previous], to);
                if renamed != current {
                    dialog.SetFileName(&HSTRING::from(renamed))?;
                }
            }
        }
        Ok(())
    }
    fn OnOverwrite(
        &self,
        _: Ref<'_, IFileDialog>,
        _: Ref<'_, IShellItem>,
    ) -> WinResult<FDE_OVERWRITE_RESPONSE> {
        Ok(FDE_OVERWRITE_RESPONSE(0))
    }
}

/// Show the dialog owned by `owner` and wait; `None` when canceled.
pub fn show(owner: HWND, request: PanelRequest) -> PanelAnswer {
    // SAFETY: COM on this (the window's) thread; a successful initialize is
    // balanced below, an already-initialized thread is left as it was.
    let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
    let answer = unsafe { run(owner, request) }.map_err(|e| e.message());
    if initialized {
        // SAFETY: balances the CoInitializeEx above.
        unsafe { CoUninitialize() };
    }
    answer
}

/// # Safety
/// Call on a COM apartment thread that owns `owner`.
unsafe fn run(owner: HWND, mut request: PanelRequest) -> WinResult<Option<PanelResult>> {
    let dialog: IFileSaveDialog = CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)?;
    let chosen = request.initial.min(request.formats.len() - 1);

    // The "Save as type" list. The strings outlive the call that copies them.
    let names: Vec<HSTRING> = request
        .formats
        .iter()
        .map(|f| HSTRING::from(f.label.as_str()))
        .collect();
    let specs: Vec<HSTRING> = request
        .formats
        .iter()
        .map(|f| HSTRING::from(format!("*.{}", f.extension)))
        .collect();
    let filters: Vec<COMDLG_FILTERSPEC> = names
        .iter()
        .zip(&specs)
        .map(|(n, s)| COMDLG_FILTERSPEC {
            pszName: PCWSTR(n.as_ptr()),
            pszSpec: PCWSTR(s.as_ptr()),
        })
        .collect();
    dialog.SetFileTypes(&filters)?;
    dialog.SetFileTypeIndex(chosen as u32 + 1)?;
    dialog.SetDefaultExtension(&HSTRING::from(request.formats[chosen].extension.as_str()))?;
    dialog.SetFileName(&HSTRING::from(request.default_name.as_str()))?;
    dialog.SetTitle(&HSTRING::from(request.title.as_str()))?;
    // Strict types: the name takes the chosen type's extension, whatever
    // was typed.
    dialog.SetOptions(
        dialog.GetOptions()? | FOS_OVERWRITEPROMPT | FOS_FORCEFILESYSTEM | FOS_STRICTFILETYPES,
    )?;

    // Every format's options, added once; the event sink shows the chosen
    // type's.
    let customize: IFileDialogCustomize = dialog.cast()?;
    for (f, format) in request.formats.iter().enumerate() {
        for (o, option) in format.options.iter().enumerate() {
            let (group, control) = ids(f, o);
            match option {
                PanelOption::Select {
                    label,
                    choices,
                    value,
                    ..
                } => {
                    customize.StartVisualGroup(group, &HSTRING::from(label.as_str()))?;
                    customize.AddComboBox(control)?;
                    for (k, choice) in choices.iter().enumerate() {
                        customize.AddControlItem(
                            control,
                            k as u32,
                            &HSTRING::from(choice.label.as_str()),
                        )?;
                    }
                    let at = choices.iter().position(|c| &c.value == value).unwrap_or(0);
                    customize.SetSelectedControlItem(control, at as u32)?;
                    customize.EndVisualGroup()?;
                }
                PanelOption::Check { label, value, .. } => {
                    customize.AddCheckButton(control, &HSTRING::from(label.as_str()), *value)?;
                }
            }
        }
    }
    let layout = Rc::new(Layout {
        kinds: request
            .formats
            .iter()
            .map(|f| {
                f.options
                    .iter()
                    .map(|o| matches!(o, PanelOption::Select { .. }))
                    .collect()
            })
            .collect(),
        extensions: request
            .formats
            .iter()
            .map(|f| f.extension.clone())
            .collect(),
    });
    layout.show(&customize, chosen);
    let chosen_cell = Rc::new(Cell::new(chosen));
    let events: IFileDialogEvents = Events {
        layout: layout.clone(),
        chosen: chosen_cell.clone(),
    }
    .into();
    let cookie = dialog.Advise(&events)?;

    let shown = dialog.Show(Some(owner));
    let _ = dialog.Unadvise(cookie);
    if let Err(e) = shown {
        // Cancel answers ERROR_CANCELLED; anything else is a failure.
        if e.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
            return Ok(None);
        }
        return Err(e);
    }

    let item = dialog.GetResult()?;
    let path_buf = item.GetDisplayName(SIGDN_FILESYSPATH)?;
    let path = path_buf.to_string().unwrap_or_default();
    CoTaskMemFree(Some(path_buf.0 as *const _));
    let f = (dialog.GetFileTypeIndex()? as usize)
        .checked_sub(1)
        .filter(|&i| i < request.formats.len())
        .unwrap_or_else(|| chosen_cell.get());

    // Read the chosen type's controls back into its options.
    for (o, option) in request.formats[f].options.iter_mut().enumerate() {
        let (_, control) = ids(f, o);
        match option {
            PanelOption::Select { choices, value, .. } => {
                if let Some(c) = customize
                    .GetSelectedControlItem(control)
                    .ok()
                    .and_then(|k| choices.get(k as usize))
                {
                    *value = c.value.clone();
                }
            }
            PanelOption::Check { value, .. } => {
                if let Ok(state) = customize.GetCheckButtonState(control) {
                    *value = state.as_bool();
                }
            }
        }
    }
    Ok(Some(result_for(path, &request.formats[f])))
}
