// Keeps a Windows release build from opening a console window next to the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    coasterworks_desktop_lib::run()
}
