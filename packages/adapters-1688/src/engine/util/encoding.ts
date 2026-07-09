import iconv from 'iconv-lite';

export function encodeGbkPercent(input: string): string {
  const gbkBytes = iconv.encode(input, 'gbk');
  return Array.from(gbkBytes)
    .map((b) => '%' + b.toString(16).padStart(2, '0').toUpperCase())
    .join('');
}
