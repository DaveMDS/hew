//! macOS: NSSavePanel with an accessory view — a "Format:" popup and the
//! chosen format's options under it, labels right-aligned as a Mac panel's
//! are (Preview's Export, SketchUp's own).

use super::model::{rename_for, result_for, PanelOption, PanelRequest};
use super::PanelAnswer;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSButton, NSControlStateValueOff, NSControlStateValueOn, NSGridCell, NSGridCellPlacement,
    NSGridRowAlignment, NSGridView, NSModalResponseOK, NSPopUpButton, NSSavePanel, NSTextField,
    NSView,
};
use objc2_foundation::{NSArray, NSPoint, NSRect, NSSize, NSString};
use std::cell::RefCell;
use std::sync::mpsc;

/// The live controls of the chosen format's options, in its order.
enum Control {
    Select(Retained<NSPopUpButton>),
    Check(Retained<NSButton>),
}

struct State {
    request: PanelRequest,
    current: usize,
    panel: Retained<NSSavePanel>,
    controls: Vec<Control>,
}

impl State {
    /// Read the controls back into the chosen format's option values.
    fn harvest(&mut self) {
        let options = &mut self.request.formats[self.current].options;
        for (option, control) in options.iter_mut().zip(&self.controls) {
            match (option, control) {
                (PanelOption::Select { choices, value, .. }, Control::Select(p)) => {
                    if let Some(c) = usize::try_from(p.indexOfSelectedItem())
                        .ok()
                        .and_then(|i| choices.get(i))
                    {
                        *value = c.value.clone();
                    }
                }
                (PanelOption::Check { value, .. }, Control::Check(b)) => {
                    *value = b.state() == NSControlStateValueOn;
                }
                _ => {}
            }
        }
    }
}

pub struct Ivars {
    state: RefCell<Option<State>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and the class
    // does not implement Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "HewSavePanelFormatTarget"]
    #[ivars = Ivars]
    struct FormatTarget;

    impl FormatTarget {
        /// The Format popup changed: keep the options set so far, show
        /// the new format's, and give the name its extension.
        #[unsafe(method(formatChanged:))]
        fn format_changed(&self, sender: &NSPopUpButton) {
            let Ok(next) = usize::try_from(sender.indexOfSelectedItem()) else {
                return;
            };
            let mtm = self.mtm();
            let mut slot = self.ivars().state.borrow_mut();
            let Some(state) = slot.as_mut() else { return };
            if next == state.current || next >= state.request.formats.len() {
                return;
            }
            state.harvest();
            let from = state.request.formats[state.current].extension.clone();
            state.current = next;
            let to = state.request.formats[next].extension.clone();
            let name = state.panel.nameFieldStringValue().to_string();
            allow(&state.panel, &to);
            state
                .panel
                .setNameFieldStringValue(&NSString::from_str(&rename_for(&name, &from, &to)));
            let view = accessory(mtm, state, self);
            state.panel.setAccessoryView(Some(&view));
        }
    }
);

fn allow(panel: &NSSavePanel, extension: &str) {
    let types = NSArray::from_retained_slice(&[NSString::from_str(extension)]);
    #[allow(deprecated)]
    panel.setAllowedFileTypes(Some(&types));
}

fn popup(mtm: MainThreadMarker, titles: &[&str], selected: usize) -> Retained<NSPopUpButton> {
    let p = NSPopUpButton::initWithFrame_pullsDown(
        NSPopUpButton::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(10.0, 10.0)),
        false,
    );
    let titles: Vec<Retained<NSString>> = titles.iter().map(|t| NSString::from_str(t)).collect();
    p.addItemsWithTitles(&NSArray::from_retained_slice(&titles));
    p.selectItemAtIndex(selected as isize);
    p
}

/// The accessory view for the chosen format: a "Format:" popup and the
/// format's options, labels right-aligned in one column as a Mac
/// panel's are.
fn accessory(mtm: MainThreadMarker, state: &mut State, target: &FormatTarget) -> Retained<NSView> {
    let label = |s: &str| NSTextField::labelWithString(&NSString::from_str(s), mtm);
    let labels: Vec<&str> = state
        .request
        .formats
        .iter()
        .map(|f| f.label.as_str())
        .collect();
    let format = popup(mtm, &labels, state.current);
    // SAFETY: the target outlives the panel's run (it is held for the
    // whole of `run`), and the action takes one NSPopUpButton argument.
    unsafe {
        format.setTarget(Some(target as &AnyObject));
        format.setAction(Some(sel!(formatChanged:)));
    }
    let format_label = label("Format:");
    let mut rows: Vec<Retained<NSArray<NSView>>> = vec![NSArray::from_slice(&[
        &**format_label as &NSView,
        &***format,
    ])];
    state.controls.clear();
    for option in &state.request.formats[state.current].options {
        match option {
            PanelOption::Select {
                label: text,
                choices,
                value,
                ..
            } => {
                let titles: Vec<&str> = choices.iter().map(|c| c.label.as_str()).collect();
                let at = choices.iter().position(|c| &c.value == value).unwrap_or(0);
                let p = popup(mtm, &titles, at);
                let l = label(&format!("{text}:"));
                rows.push(NSArray::from_slice(&[&**l as &NSView, &***p]));
                state.controls.push(Control::Select(p));
            }
            PanelOption::Check {
                label: text, value, ..
            } => {
                // SAFETY: no target or action — the value is read back
                // when the panel closes.
                let b = unsafe {
                    NSButton::checkboxWithTitle_target_action(
                        &NSString::from_str(text),
                        None,
                        None,
                        mtm,
                    )
                };
                b.setState(if *value {
                    NSControlStateValueOn
                } else {
                    NSControlStateValueOff
                });
                let empty = NSGridCell::emptyContentView(mtm);
                rows.push(NSArray::from_slice(&[&*empty, &**b as &NSView]));
                state.controls.push(Control::Check(b));
            }
        }
    }
    let grid = NSGridView::gridViewWithViews(&NSArray::from_retained_slice(&rows), mtm);
    grid.columnAtIndex(0)
        .setXPlacement(NSGridCellPlacement::Trailing);
    grid.setRowAlignment(NSGridRowAlignment::FirstBaseline);
    grid.setColumnSpacing(8.0);
    grid.setRowSpacing(8.0);
    let size = grid.fittingSize();
    let pad = 12.0;
    let container = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(
            NSPoint::new(0.0, 0.0),
            NSSize::new(size.width + 2.0 * pad, size.height + 2.0 * pad),
        ),
    );
    grid.setFrame(NSRect::new(NSPoint::new(pad, pad), size));
    container.addSubview(&grid);
    container
}

pub fn run(window: &tauri::WebviewWindow, request: PanelRequest) -> PanelAnswer {
    let (tx, rx) = mpsc::channel::<PanelAnswer>();
    window
        .with_webview(move |_| {
            // `with_webview` runs this on the main thread.
            let answer = match MainThreadMarker::new() {
                Some(mtm) => show(mtm, request),
                None => Err("the save panel needs the main thread".into()),
            };
            let _ = tx.send(answer);
        })
        .map_err(|e| e.to_string())?;
    super::received(rx)
}

fn show(mtm: MainThreadMarker, request: PanelRequest) -> PanelAnswer {
    let panel = NSSavePanel::savePanel(mtm);
    panel.setTitle(Some(&NSString::from_str(&request.title)));
    panel.setCanCreateDirectories(true);
    let current = request.initial.min(request.formats.len() - 1);
    let extension = request.formats[current].extension.clone();
    // The allowed type first: set after, it appends its extension to
    // a name that already ends in it (`Model.hew.hew`).
    allow(&panel, &extension);
    panel.setNameFieldStringValue(&NSString::from_str(&request.default_name));
    let target = FormatTarget::alloc(mtm).set_ivars(Ivars {
        state: RefCell::new(Some(State {
            request,
            current,
            panel: panel.clone(),
            controls: Vec::new(),
        })),
    });
    // SAFETY: NSObject's designated initializer.
    let target: Retained<FormatTarget> = unsafe { msg_send![super(target), init] };
    {
        let mut slot = target.ivars().state.borrow_mut();
        let state = slot.as_mut().ok_or("the save panel lost its formats")?;
        let view = accessory(mtm, state, &target);
        panel.setAccessoryView(Some(&view));
    }
    let response = panel.runModal();
    let mut state = target
        .ivars()
        .state
        .borrow_mut()
        .take()
        .ok_or("the save panel lost its formats")?;
    // The panel no longer needs the target (its popup held it unretained).
    panel.setAccessoryView(None);
    if response != NSModalResponseOK {
        return Ok(None);
    }
    state.harvest();
    let path = panel
        .URL()
        .and_then(|u| u.path())
        .ok_or("the save panel gave no file path")?
        .to_string();
    Ok(Some(result_for(
        path,
        &state.request.formats[state.current],
    )))
}
