use super::models::Account;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub trait Credentials: Send + Sync {
    fn get(&self, id: &str) -> Result<Option<String>, String>;
    fn set(&self, id: &str, token: &str) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
}

pub struct NativeCredentials;

#[cfg(any(windows, target_os = "macos"))]
fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.ideagittool.desktop.hosting", id)
        .map_err(|_| "无法访问系统凭据库".into())
}

#[cfg(any(windows, target_os = "macos"))]
impl Credentials for NativeCredentials {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        match entry(id)?.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("读取系统凭据失败，请重新登录".into()),
        }
    }

    fn set(&self, id: &str, token: &str) -> Result<(), String> {
        entry(id)?
            .set_password(token)
            .map_err(|_| "保存系统凭据失败".into())
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        match entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("删除系统凭据失败".into()),
        }
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
impl Credentials for NativeCredentials {
    fn get(&self, _: &str) -> Result<Option<String>, String> {
        Err("此平台尚未接入系统凭据库".into())
    }
    fn set(&self, _: &str, _: &str) -> Result<(), String> {
        Err("此平台尚未接入系统凭据库".into())
    }
    fn delete(&self, _: &str) -> Result<(), String> {
        Err("此平台尚未接入系统凭据库".into())
    }
}

pub struct AccountStore {
    directory: PathBuf,
    credentials: Arc<dyn Credentials>,
}

impl AccountStore {
    pub fn new(directory: PathBuf, credentials: Arc<dyn Credentials>) -> Self {
        Self {
            directory,
            credentials,
        }
    }

    // Held across token refresh and account writes, including across app processes.
    pub fn session_guard(&self) -> Result<File, String> {
        std::fs::create_dir_all(&self.directory).map_err(|error| error.to_string())?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.directory.join("hosting-session.lock"))
            .map_err(|error| error.to_string())?;
        file.lock().map_err(|error| error.to_string())?;
        Ok(file)
    }

    fn lock(&self) -> Result<File, String> {
        std::fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.directory.join("hosting-accounts.lock"))
            .map_err(|e| e.to_string())?;
        file.lock().map_err(|e| e.to_string())?;
        Ok(file)
    }

    fn path(&self) -> PathBuf {
        self.directory.join("hosting-accounts.json")
    }

    fn read(&self) -> Result<Vec<Account>, String> {
        match std::fs::read(self.path()) {
            Ok(data) => serde_json::from_slice(&data)
                .map_err(|_| "账户配置损坏，请检查 hosting-accounts.json".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(error) => Err(error.to_string()),
        }
    }

    fn write(&self, accounts: &[Account]) -> Result<(), String> {
        write_json(&self.path(), accounts)
    }

    pub fn list(&self) -> Result<Vec<Account>, String> {
        let _lock = self.lock()?;
        self.read()
    }

    pub fn session(&self, id: &str) -> Result<(Account, String), String> {
        let _lock = self.lock()?;
        let account = self
            .read()?
            .into_iter()
            .find(|item| item.id == id)
            .ok_or("账户已移除，请重新选择")?;
        if super::api::account_id(account.provider, &account.server, &account.user_id) != account.id
        {
            return Err("账户配置与凭据不匹配，请重新添加账户".into());
        }
        let token = self
            .credentials
            .get(id)?
            .ok_or("账户凭据已失效，请重新登录")?;
        Ok((account, token))
    }

    pub fn save(&self, account: Account, token: &str) -> Result<Account, String> {
        let _lock = self.lock()?;
        let mut accounts = self.read()?;
        let old_token = self.credentials.get(&account.id)?;
        self.credentials.set(&account.id, token)?;
        accounts.retain(|item| item.id != account.id);
        accounts.push(account.clone());
        if let Err(error) = self.write(&accounts) {
            let rollback = match old_token {
                Some(old) => self.credentials.set(&account.id, &old),
                None => self.credentials.delete(&account.id),
            };
            rollback.map_err(|_| "保存账户失败，恢复凭据也失败，请重新登录".to_owned())?;
            return Err(error);
        }
        Ok(account)
    }

    pub fn replace_token(&self, id: &str, expected: &str, token: &str) -> Result<(), String> {
        let _lock = self.lock()?;
        if !self.read()?.iter().any(|account| account.id == id)
            || self.credentials.get(id)?.as_deref() != Some(expected)
        {
            return Err("账户凭据已经变化，请重新登录".into());
        }
        self.credentials.set(id, token)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let _lock = self.lock()?;
        let accounts = self.read()?;
        let token = self.credentials.get(id)?;
        self.credentials.delete(id)?;
        let remaining: Vec<_> = accounts.into_iter().filter(|item| item.id != id).collect();
        if let Err(error) = self.write(&remaining) {
            if let Some(token) = token {
                self.credentials
                    .set(id, &token)
                    .map_err(|_| "移除账户失败，请重新登录".to_owned())?;
            }
            return Err(error);
        }
        Ok(())
    }
}

fn write_json(path: &Path, accounts: &[Account]) -> Result<(), String> {
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("账户目录无效")?)
        .map_err(|e| e.to_string())?;
    let data = serde_json::to_vec_pretty(accounts).map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}
