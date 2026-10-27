
/** 数据驱动的项目封面缩略图：由项目 ID/镜头数/进度确定性生成 16:9 分镜条 SVG。 */
export function CoverThumb({ seed, shots, progress, tone }: {
  seed: string;
  shots: number;
  progress: number;
  tone: number;
}) {
  const tones: Array<[string, string, string]> = [
    ['#262a40', '#3a3f66', '#8a8ff0'],
    ['#1f2f38', '#2b4750', '#4fd1c5'],
    ['#32262d', '#4a3947', '#e08fb8'],
    ['#2c2921', '#473f2f', '#d8b45a'],
  ];
  const [bg, panel, accent] = tones[tone % 4];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const rand = (n: number) => ((hash >> ((n % 10) * 3)) % 100) / 100;
  const frameCount = Math.min(6, Math.max(3, Math.round(shots / 3) || 3));
  const frames = Array.from({ length: frameCount }, (_, i) => {
    const w = 24 + rand(i) * 22;
    const x = Math.min(10 + i * (140 / frameCount) + rand(i + 1) * 6, 160 - w - 6);
    return { x, w, y: 22 + rand(i + 2) * 22, h: 28 + rand(i + 3) * 26 };
  });
  return (
    <svg className="cover-thumb" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="160" height="90" fill={bg} />
      <rect x="0" y="0" width="160" height="12" fill={panel} opacity="0.9" />
      <circle cx="8" cy="6" r="2" fill={accent} opacity="0.7" />
      <circle cx="15" cy="6" r="2" fill={accent} opacity="0.4" />
      {frames.map((frame, i) => (
        <g key={i}>
          <rect x={frame.x} y={frame.y} width={frame.w} height={frame.h} rx="3" fill={panel} opacity="0.85" />
          <rect x={frame.x} y={frame.y} width={frame.w} height="3" rx="1.5" fill={accent} opacity="0.55" />
        </g>
      ))}
      <rect x="10" y="80" width="140" height="4" rx="2" fill={panel} />
      <rect x="10" y="80" width={Math.max(6, Math.round(140 * progress / 100))} height="4" rx="2" fill={accent} />
    </svg>
  );
}
