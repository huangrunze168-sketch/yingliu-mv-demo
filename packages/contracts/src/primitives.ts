import { z } from 'zod';

/**
 * 跨契约共用的标量类型。
 *
 * 单独成文件是为了避免循环引用：`index.ts` 与各契约文件都要用到它们，
 * 若把它们留在 `index.ts` 里，`spatial-plan.ts` 就得反向 import `index.ts`。
 */

export const uuidSchema = z.string().uuid();

/** 内容寻址标识：只允许 `sha256:<64 位小写十六进制>`，不接受路径或 URL。 */
export const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const rfc3339Schema = z.string().datetime({ offset: true });
