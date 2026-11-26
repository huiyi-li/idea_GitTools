export const ENCODING_OPTIONS = [
  { value: 'UTF-8', label: 'UTF-8' },
  { value: 'UTF-8 BOM', label: 'UTF-8 BOM' },
  { value: 'GBK', label: 'GBK / GB2312' },
  { value: 'GB18030', label: 'GB18030' },
  { value: 'Big5', label: 'Big5' },
  { value: 'Shift_JIS', label: 'Shift_JIS' },
  { value: 'EUC-KR', label: 'EUC-KR' },
  { value: 'UTF-16LE', label: 'UTF-16LE' },
  { value: 'UTF-16BE', label: 'UTF-16BE' },
  { value: 'Windows-1252', label: 'Windows-1252' },
] as const;

export function EncodingSelect({
  value,
  detected,
  disabled,
  onChange,
}: {
  value: string;
  detected?: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const autoLabel = detected ? `自动 (${detected})` : '自动识别';
  return (
    <label class="encoding-selector" title="查看或保存时使用的字符编码（支持 GB2312 / GBK / UTF-8 等）">
      <select
        aria-label="文件编码"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <option value="auto">{autoLabel}</option>
        {ENCODING_OPTIONS.map((item) => (
          <option key={item.value} value={item.value}>
            {item.label}
          </option>
        ))}
      </select>
    </label>
  );
}
