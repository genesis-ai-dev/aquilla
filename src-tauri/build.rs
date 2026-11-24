fn main() {
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        cc::Build::new()
            .file("src/mac_google.m")
            .flag("-fobjc-arc")
            .compile("mac_google");
        println!("cargo:rustc-link-lib=framework=AuthenticationServices");
        println!("cargo:rerun-if-changed=src/mac_google.m");
    }
    tauri_build::build()
}
