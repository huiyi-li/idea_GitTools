use chardetng::EncodingDetector;
use encoding_rs::{Encoding, BIG5, EUC_KR, GB18030, GBK, SHIFT_JIS, UTF_16BE, UTF_16LE, WINDOWS_1252};

pub const DEFAULT_ENCODING: &str = "UTF-8";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedText {
    pub text: String,
    pub encoding: String,
}

pub fn has_utf16_bom(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\xFF\xFE") || bytes.starts_with(b"\xFE\xFF")
}

pub fn canonical_label(encoding: &'static Encoding) -> &'static str {
    if encoding == GBK {
        "GBK"
    } else if encoding == GB18030 {
        "GB18030"
    } else if encoding == BIG5 {
        "Big5"
    } else if encoding == SHIFT_JIS {
        "Shift_JIS"
    } else if encoding == EUC_KR {
        "EUC-KR"
    } else if encoding == WINDOWS_1252 {
        "Windows-1252"
    } else if encoding == UTF_16LE {
        "UTF-16LE"
    } else if encoding == UTF_16BE {
        "UTF-16BE"
    } else {
        encoding.name()
    }
}

pub fn lookup_encoding(label: &str) -> Option<&'static Encoding> {
    let trimmed = label.trim();
    if trimmed.eq_ignore_ascii_case("GBK") || trimmed.eq_ignore_ascii_case("GB2312") {
        Some(GBK)
    } else if trimmed.eq_ignore_ascii_case("GB18030") {
        Some(GB18030)
    } else if trimmed.eq_ignore_ascii_case("Big5") {
        Some(BIG5)
    } else if trimmed.eq_ignore_ascii_case("Shift_JIS") || trimmed.eq_ignore_ascii_case("SJIS") {
        Some(SHIFT_JIS)
    } else if trimmed.eq_ignore_ascii_case("EUC-KR") {
        Some(EUC_KR)
    } else if trimmed.eq_ignore_ascii_case("Windows-1252") || trimmed.eq_ignore_ascii_case("CP1252") {
        Some(WINDOWS_1252)
    } else if trimmed.eq_ignore_ascii_case("UTF-16LE") {
        Some(UTF_16LE)
    } else if trimmed.eq_ignore_ascii_case("UTF-16BE") {
        Some(UTF_16BE)
    } else {
        Encoding::for_label(trimmed.as_bytes())
    }
}

fn decode_utf16(bytes: &[u8], encoding: &'static Encoding, label: &str) -> Option<DecodedText> {
    let payload = if (encoding == UTF_16LE && bytes.starts_with(b"\xFF\xFE"))
        || (encoding == UTF_16BE && bytes.starts_with(b"\xFE\xFF"))
    {
        &bytes[2..]
    } else {
        bytes
    };
    if payload.len() % 2 != 0 {
        return None;
    }
    let (decoded, had_errors) = encoding.decode_without_bom_handling(payload);
    if had_errors {
        return None;
    }
    Some(DecodedText {
        text: decoded.into_owned(),
        encoding: label.to_string(),
    })
}

fn decode_with_explicit(bytes: &[u8], label: &str) -> Result<DecodedText, String> {
    let trimmed = label.trim();
    if trimmed.eq_ignore_ascii_case("UTF-8 BOM") {
        let payload = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
        let text = std::str::from_utf8(payload)
            .map_err(|_| "无法使用 UTF-8 BOM 解码此文件".to_string())?;
        return Ok(DecodedText {
            text: text.to_string(),
            encoding: "UTF-8 BOM".to_string(),
        });
    }
    if trimmed.eq_ignore_ascii_case("UTF-8") {
        let payload = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
        let text = std::str::from_utf8(payload)
            .map_err(|_| "无法使用 UTF-8 解码此文件".to_string())?;
        return Ok(DecodedText {
            text: text.to_string(),
            encoding: "UTF-8".to_string(),
        });
    }
    if trimmed.eq_ignore_ascii_case("UTF-16LE") {
        return decode_utf16(bytes, UTF_16LE, "UTF-16LE")
            .ok_or_else(|| "无法使用 UTF-16LE 解码此文件".to_string());
    }
    if trimmed.eq_ignore_ascii_case("UTF-16BE") {
        return decode_utf16(bytes, UTF_16BE, "UTF-16BE")
            .ok_or_else(|| "无法使用 UTF-16BE 解码此文件".to_string());
    }
    let encoding = lookup_encoding(trimmed)
        .ok_or_else(|| format!("不支持的字符编码: {label}"))?;
    let (decoded, had_errors) = encoding.decode_without_bom_handling(bytes);
    if had_errors {
        return Err(format!("无法使用 {trimmed} 解码此文件"));
    }
    Ok(DecodedText {
        text: decoded.into_owned(),
        encoding: canonical_label(encoding).to_string(),
    })
}

pub fn decode_text(bytes: &[u8], preferred: Option<&str>) -> Result<DecodedText, String> {
    if let Some(label) = preferred.map(str::trim).filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("auto")) {
        return decode_with_explicit(bytes, label);
    }

    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        if let Ok(text) = std::str::from_utf8(rest) {
            return Ok(DecodedText {
                text: text.to_string(),
                encoding: "UTF-8 BOM".to_string(),
            });
        }
    }
    if bytes.starts_with(b"\xFF\xFE") {
        return decode_utf16(bytes, UTF_16LE, "UTF-16LE")
            .ok_or_else(|| "无法识别 UTF-16LE 文件内容".to_string());
    }
    if bytes.starts_with(b"\xFE\xFF") {
        return decode_utf16(bytes, UTF_16BE, "UTF-16BE")
            .ok_or_else(|| "无法识别 UTF-16BE 文件内容".to_string());
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok(DecodedText {
            text: text.to_string(),
            encoding: "UTF-8".to_string(),
        });
    }

    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let guessed = detector.guess(None, true);

    let mut candidates = Vec::with_capacity(6);
    if guessed != encoding_rs::UTF_8 {
        candidates.push(guessed);
    }
    for fallback in [GBK, GB18030, BIG5, SHIFT_JIS, EUC_KR] {
        if !candidates.contains(&fallback) {
            candidates.push(fallback);
        }
    }

    for candidate in candidates {
        let (decoded, had_errors) = candidate.decode_without_bom_handling(bytes);
        if !had_errors {
            return Ok(DecodedText {
                text: decoded.into_owned(),
                encoding: canonical_label(candidate).to_string(),
            });
        }
    }

    Err("无法识别文件字符编码".to_string())
}

pub fn decode_lossy_with_hint(bytes: &[u8], preferred: Option<&str>) -> String {
    if let Ok(decoded) = decode_text(bytes, preferred) {
        return decoded.text;
    }
    if let Some(encoding) = preferred.and_then(lookup_encoding) {
        return encoding.decode_without_bom_handling(bytes).0.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

pub fn encode_text(text: &str, encoding_label: &str) -> Result<Vec<u8>, String> {
    let trimmed = encoding_label.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("UTF-8") {
        return Ok(text.as_bytes().to_vec());
    }
    if trimmed.eq_ignore_ascii_case("UTF-8 BOM") {
        let mut out = Vec::with_capacity(3 + text.len());
        out.extend_from_slice(b"\xEF\xBB\xBF");
        out.extend_from_slice(text.as_bytes());
        return Ok(out);
    }
    if trimmed.eq_ignore_ascii_case("UTF-16LE") {
        let mut out = Vec::with_capacity(2 + text.len() * 2);
        out.extend_from_slice(b"\xFF\xFE");
        for unit in text.encode_utf16() {
            out.extend_from_slice(&unit.to_le_bytes());
        }
        return Ok(out);
    }
    if trimmed.eq_ignore_ascii_case("UTF-16BE") {
        let mut out = Vec::with_capacity(2 + text.len() * 2);
        out.extend_from_slice(b"\xFE\xFF");
        for unit in text.encode_utf16() {
            out.extend_from_slice(&unit.to_be_bytes());
        }
        return Ok(out);
    }
    let encoding = lookup_encoding(trimmed)
        .ok_or_else(|| format!("不支持的保存编码: {encoding_label}"))?;
    let (encoded, _, had_errors) = encoding.encode(text);
    if had_errors {
        return Err(format!(
            "文件内容包含无法用 {trimmed} 编码表示的字符，请切换为 UTF-8 后保存"
        ));
    }
    Ok(encoded.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_and_encodes_gbk_gb2312_and_utf8_bom() {
        let sample = "中文编码测试：你好，世界！\n";
        let gbk_bytes = encode_text(sample, "GBK").unwrap();
        assert!(std::str::from_utf8(&gbk_bytes).is_err());

        let decoded = decode_text(&gbk_bytes, None).unwrap();
        assert_eq!(decoded.text, sample);
        assert!(matches!(decoded.encoding.as_str(), "GBK" | "GB18030"));

        let explicit_gb2312 = decode_text(&gbk_bytes, Some("GB2312")).unwrap();
        assert_eq!(explicit_gb2312.text, sample);

        let bom_bytes = encode_text(sample, "UTF-8 BOM").unwrap();
        assert!(bom_bytes.starts_with(b"\xEF\xBB\xBF"));
        let decoded_bom = decode_text(&bom_bytes, None).unwrap();
        assert_eq!(decoded_bom.text, sample);
        assert_eq!(decoded_bom.encoding, "UTF-8 BOM");
    }

    #[test]
    fn decodes_and_encodes_utf16_with_bom() {
        let sample = "Hello 世界\r\n";
        let le_bytes = encode_text(sample, "UTF-16LE").unwrap();
        assert!(has_utf16_bom(&le_bytes));
        let decoded_le = decode_text(&le_bytes, None).unwrap();
        assert_eq!(decoded_le.text, sample);
        assert_eq!(decoded_le.encoding, "UTF-16LE");

        let be_bytes = encode_text(sample, "UTF-16BE").unwrap();
        let decoded_be = decode_text(&be_bytes, None).unwrap();
        assert_eq!(decoded_be.text, sample);
        assert_eq!(decoded_be.encoding, "UTF-16BE");
    }

    #[test]
    fn rejects_unmappable_characters_when_encoding_to_gbk() {
        let error = encode_text("emoji 🚀", "GBK").unwrap_err();
        assert!(error.contains("GBK"));
    }
}
