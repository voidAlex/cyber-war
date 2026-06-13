// Tauri 2 桌面应用入口：禁用 Windows 控制台弹窗，其余委托给 lib::run。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cyber_war_simulator_lib::run()
}
