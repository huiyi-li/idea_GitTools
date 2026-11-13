#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if ideagittool_desktop::git_editor_helper() {
        return;
    }
    if ideagittool_desktop::transport::askpass() {
        return;
    }
    ideagittool_desktop::run();
}
