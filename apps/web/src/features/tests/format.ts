/** "2,0 KB", "1,5 MB": file sizes for people (pt-BR decimals). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const text = value >= 10 ? Math.round(value).toString() : value.toFixed(1);
  return `${text.replace('.', ',')} ${units[i]}`;
}
