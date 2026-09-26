// 초대 링크 QR 코드 (학급 수업 초대·게임방 초대가 함께 쓴다). 휴대폰 카메라로 찍으면 링크가 열린다.

import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

export function QrCode({ text, size = 240, label = '초대 QR 코드' }: { text: string; size?: number; label?: string }) {
  const path = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + 4},${y + 4}h1v1h-1z`;
    return { d, n };
  }, [text]);
  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${path.n + 8} ${path.n + 8}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width="100%" height="100%" fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}
