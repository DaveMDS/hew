//! Linux: GTK's file chooser with its own file-type filter list, and the
//! chosen type's options in the chooser's extra widget, rebuilt when the
//! filter changes.

use super::model::{
    rename_for, result_for, with_extension, PanelOption, PanelRequest, PanelResult,
};
use gtk::prelude::*;
use std::cell::RefCell;
use std::rc::Rc;

/// The live controls of the chosen format's options, in its order.
enum Control {
    Select(gtk::ComboBoxText),
    Check(gtk::CheckButton),
}

struct State {
    request: PanelRequest,
    current: usize,
    controls: Vec<Control>,
}

impl State {
    /// Read the controls back into the chosen format's option values.
    fn harvest(&mut self) {
        let options = &mut self.request.formats[self.current].options;
        for (option, control) in options.iter_mut().zip(&self.controls) {
            match (option, control) {
                (PanelOption::Select { value, .. }, Control::Select(c)) => {
                    if let Some(id) = c.active_id() {
                        *value = id.to_string();
                    }
                }
                (PanelOption::Check { value, .. }, Control::Check(b)) => *value = b.is_active(),
                _ => {}
            }
        }
    }

    /// The chosen format's options, labels right-aligned beside them.
    fn options_widget(&mut self) -> gtk::Grid {
        let grid = gtk::Grid::new();
        grid.set_row_spacing(6);
        grid.set_column_spacing(8);
        self.controls.clear();
        for (row, option) in self.request.formats[self.current]
            .options
            .iter()
            .enumerate()
        {
            let row = row as i32;
            match option {
                PanelOption::Select {
                    label,
                    choices,
                    value,
                    ..
                } => {
                    let l = gtk::Label::new(Some(&format!("{label}:")));
                    l.set_halign(gtk::Align::End);
                    let combo = gtk::ComboBoxText::new();
                    for c in choices {
                        combo.append(Some(&c.value), &c.label);
                    }
                    combo.set_active_id(Some(value));
                    grid.attach(&l, 0, row, 1, 1);
                    grid.attach(&combo, 1, row, 1, 1);
                    self.controls.push(Control::Select(combo));
                }
                PanelOption::Check { label, value, .. } => {
                    let b = gtk::CheckButton::with_label(label);
                    b.set_active(*value);
                    grid.attach(&b, 1, row, 1, 1);
                    self.controls.push(Control::Check(b));
                }
            }
        }
        grid.show_all();
        grid
    }
}

/// Show the chooser over `parent` and wait; `None` when canceled.
pub fn show(parent: Option<&gtk::Window>, request: PanelRequest) -> Option<PanelResult> {
    let dialog = gtk::FileChooserDialog::with_buttons(
        Some(&request.title),
        parent,
        gtk::FileChooserAction::Save,
        &[
            ("_Cancel", gtk::ResponseType::Cancel),
            ("_Save", gtk::ResponseType::Accept),
        ],
    );
    dialog.set_do_overwrite_confirmation(true);
    let current = request.initial.min(request.formats.len() - 1);
    let filters: Vec<gtk::FileFilter> = request
        .formats
        .iter()
        .map(|f| {
            let filter = gtk::FileFilter::new();
            filter.set_name(Some(&f.label));
            filter.add_pattern(&format!("*.{}", f.extension));
            dialog.add_filter(filter.clone());
            filter
        })
        .collect();
    dialog.set_filter(&filters[current]);
    dialog.set_current_name(&request.default_name);

    let state = Rc::new(RefCell::new(State {
        request,
        current,
        controls: Vec::new(),
    }));
    let options = state.borrow_mut().options_widget();
    dialog.set_extra_widget(&options);
    {
        let state = state.clone();
        dialog.connect_filter_notify(move |d| {
            let Some(chosen) = d.filter() else { return };
            let Some(next) = filters.iter().position(|f| f == &chosen) else {
                return;
            };
            let mut s = state.borrow_mut();
            if next == s.current {
                return;
            }
            s.harvest();
            let from = s.request.formats[s.current].extension.clone();
            s.current = next;
            let to = s.request.formats[next].extension.clone();
            if let Some(name) = d.current_name() {
                d.set_current_name(&rename_for(&name, &from, &to));
            }
            let options = s.options_widget();
            d.set_extra_widget(&options);
        });
    }

    // GTK keeps what was typed: the chosen format's extension is added
    // here, and a file that name then lands on is confirmed like any other
    // the chooser would replace.
    let result = loop {
        if dialog.run() != gtk::ResponseType::Accept {
            break None;
        }
        let Some(typed) = dialog.filename() else {
            break None;
        };
        let typed = typed.to_string_lossy().into_owned();
        let extension = {
            let s = state.borrow();
            s.request.formats[s.current].extension.clone()
        };
        let path = with_extension(&typed, &extension);
        if path != typed && std::path::Path::new(&path).exists() && !replace(&dialog, &path) {
            continue;
        }
        // Read the controls while they are still alive.
        let mut s = state.borrow_mut();
        s.harvest();
        break Some(result_for(path, &s.request.formats[s.current]));
    };
    // SAFETY: the dialog is ours alone and is not used after this.
    unsafe { dialog.destroy() };
    result
}

/// Ask whether to replace the file at `path`, as the chooser itself asks.
fn replace(parent: &gtk::FileChooserDialog, path: &str) -> bool {
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let ask = gtk::MessageDialog::new(
        Some(parent),
        gtk::DialogFlags::MODAL | gtk::DialogFlags::DESTROY_WITH_PARENT,
        gtk::MessageType::Question,
        gtk::ButtonsType::None,
        &format!("A file named \u{201c}{name}\u{201d} already exists. Do you want to replace it?"),
    );
    ask.add_buttons(&[
        ("_Cancel", gtk::ResponseType::Cancel),
        ("_Replace", gtk::ResponseType::Accept),
    ]);
    let answer = ask.run();
    // SAFETY: the question is ours alone and is not used after this.
    unsafe { ask.destroy() };
    answer == gtk::ResponseType::Accept
}
