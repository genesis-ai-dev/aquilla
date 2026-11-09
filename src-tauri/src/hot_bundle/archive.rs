//! Integrity check and extraction of a downloaded `bundle.tar.gz`.
//!
//! The tarball is remote data: every entry path is validated before it touches disk, links are
//! refused outright, and the result is only accepted when it looks like a built SPA.

use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

#[cfg(test)]
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn sha256_hex_of_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Entries must be plain relative paths (`assets/x.js`, `./index.html`); `..`, absolute paths,
/// Windows prefixes and links are rejected so a hostile archive cannot write outside `dest`.
pub fn extract_tar_gz(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = fs::File::open(archive).map_err(|e| format!("open {}: {e}", archive.display()))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in tar.entries().map_err(|e| format!("read archive: {e}"))? {
        let mut entry = entry.map_err(|e| format!("read entry: {e}"))?;
        let raw = entry.path().map_err(|e| format!("entry path: {e}"))?.into_owned();
        let relative = sanitize_entry_path(&raw)?;
        let kind = entry.header().entry_type();
        if kind.is_symlink() || kind.is_hard_link() {
            return Err(format!("archive entry {} is a link; refused", raw.display()));
        }
        let Some(relative) = relative else {
            continue; // `./` or an empty path: nothing to write
        };
        let target = dest.join(&relative);
        if kind.is_dir() {
            fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if !kind.is_file() {
            return Err(format!("archive entry {} has unsupported type {kind:?}", raw.display()));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = fs::File::create(&target).map_err(|e| format!("create {}: {e}", target.display()))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("write {}: {e}", target.display()))?;
    }
    Ok(())
}

/// `Ok(None)` for paths that name the root itself (`.`, `./`).
pub fn sanitize_entry_path(raw: &Path) -> Result<Option<PathBuf>, String> {
    let mut clean = PathBuf::new();
    for component in raw.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("archive entry {} escapes the bundle root; refused", raw.display()));
            }
        }
    }
    Ok(if clean.as_os_str().is_empty() { None } else { Some(clean) })
}

/// Where `index.html` lives inside the extracted tree: either `dest` itself or, when the tarball
/// was made from a parent directory (`tar czf bundle.tar.gz dist`), its single top-level folder.
pub fn locate_bundle_root(dest: &Path) -> Result<PathBuf, String> {
    if dest.join("index.html").is_file() {
        return Ok(dest.to_path_buf());
    }
    let entries: Vec<PathBuf> = fs::read_dir(dest)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .collect();
    if let [only] = entries.as_slice() {
        if only.is_dir() && only.join("index.html").is_file() {
            return Ok(only.clone());
        }
    }
    Err("bundle has no index.html at its root".into())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// Builds a gzipped tar in memory from `(path, bytes)` pairs.
    pub(crate) fn make_tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for (path, bytes) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            // `set_path`/`append_data` refuse `..`; writing the raw name field lets a test
            // build the hostile archive our extractor must reject.
            let name = &mut header.as_old_mut().name;
            name[..path.len()].copy_from_slice(path.as_bytes());
            header.set_cksum();
            builder.append(&header, *bytes).unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn extracts_a_normal_bundle_and_finds_its_root() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("bundle.tar.gz");
        fs::write(
            &archive,
            make_tar_gz(&[("./index.html", b"<html></html>"), ("assets/app.js", b"1")]),
        )
        .unwrap();
        let dest = dir.path().join("out");
        extract_tar_gz(&archive, &dest).unwrap();
        assert_eq!(fs::read_to_string(dest.join("index.html")).unwrap(), "<html></html>");
        assert_eq!(locate_bundle_root(&dest).unwrap(), dest);
    }

    #[test]
    fn accepts_a_single_wrapping_directory_but_not_a_missing_index() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out");
        fs::create_dir_all(dest.join("dist/assets")).unwrap();
        fs::write(dest.join("dist/index.html"), "x").unwrap();
        assert_eq!(locate_bundle_root(&dest).unwrap(), dest.join("dist"));

        fs::remove_file(dest.join("dist/index.html")).unwrap();
        assert!(locate_bundle_root(&dest).is_err());
    }

    #[test]
    fn refuses_parent_dir_and_absolute_entries() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("evil.tar.gz");
        let mut f = fs::File::create(&archive).unwrap();
        f.write_all(&make_tar_gz(&[("../escape.txt", b"pwned")])).unwrap();
        let dest = dir.path().join("out");
        let err = extract_tar_gz(&archive, &dest).unwrap_err();
        assert!(err.contains("escapes"), "{err}");
        assert!(!dir.path().join("escape.txt").exists());

        assert!(sanitize_entry_path(Path::new("/etc/passwd")).is_err());
        assert!(sanitize_entry_path(Path::new("a/../../b")).is_err());
        assert_eq!(sanitize_entry_path(Path::new("./")).unwrap(), None);
        assert_eq!(
            sanitize_entry_path(Path::new("./assets/x.js")).unwrap(),
            Some(PathBuf::from("assets/x.js"))
        );
    }

    #[test]
    fn sha256_matches_between_bytes_and_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f");
        fs::write(&p, b"hello").unwrap();
        assert_eq!(sha256_hex(b"hello"), sha256_hex_of_file(&p).unwrap());
        assert_eq!(
            sha256_hex(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }
}
