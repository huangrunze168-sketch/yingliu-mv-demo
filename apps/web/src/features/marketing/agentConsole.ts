/**
 * Agent 输入台的共享常量（落地页 / 工作台两处控制台共用，避免两套值漂移）。
 *
 * 对标依据：对标站 的 effort 档位表是
 *   [{ value: 'fast', label: 'Instant' }, { value: 'default', label: 'Medium' },
 *    { value: 'high', label: 'High' },  { value: 'xhigh', label: 'Extra High' }]
 * 显示方式是「Auto」+ 档位标签两段（见 `.agent-mode` 的注释），前半段恒为 Auto。
 */
export const AGENT_MODES: Record<string, string> = {
  'auto-low': 'Low',
  'auto-medium': 'Medium',
  'auto-high': 'High',
};

/** Lucide `plus`（对标 `[data-slot=prompt-box-attach]` 的图标，stroke-width 2） */
export const LUCIDE_PLUS_PATHS = ['M5 12h14', 'M12 5v14'] as const;

/** Lucide `sparkle`（对标 `[data-slot=prompt-box-generate]` 的图标，stroke-width 1.5，黑色填充） */
export const LUCIDE_SPARKLE_PATH =
  'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966' +
  'l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594' +
  'l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z';
