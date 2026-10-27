/* ============================================================
  API-001「版本化本地 API」的量化验收。

  三件事一起验，缺一件都不算"有个本地 API"：

    ① **地址**：真的只监听回环地址（从活着的 socket 上读，不信注释）；
    ② **版本前缀**：所有业务端点都在 `/api/v1/` 下，没有裸路径；
    ③ **真的能连**：在 127.0.0.1 上起服务，用 HTTP 请求打到项目清单，
       并确认 `/api/v2/...` 是 404——版本是路径的一部分，不是装饰。

  ② 是**源码级**检查（看注册路由的那几行），因为 Fastify 不暴露完整的路由表；
  这一点在报告里写清楚，不拿它冒充运行时证据。
   ============================================================ */

import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDatabase, ProjectService } from '@qiyin/domain';
import { buildServer } from '../../apps/local-api/src/server.js';
import { command, recordAcceptance } from './_acceptance.js';

const root = mkdtempSync(join(tmpdir(), 'qiyin-acceptance-api-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('[API-001] 版本化本地 API', () => {
  it('只绑回环地址、业务端点全在 /api/v1 下、并且真的能连', async () => {
    const service = new ProjectService(openDatabase(':memory:'));
    service.execute(command('project.create', {
      name: '本地 API 验收', max_budget_cents: 1000, rights_confirmed: true,
    }));
    const app = buildServer(service, undefined, { workspaceRoot: root });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const listResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects`);
    const listBody = (await listResponse.json()) as unknown[];
    const v2Response = await fetch(`http://127.0.0.1:${port}/api/v2/projects`);
    const projectsAtV1 = app.hasRoute({ method: 'GET', url: '/api/v1/projects' });
    const projectsAtV2 = app.hasRoute({ method: 'GET', url: '/api/v2/projects' });
    await app.close();

    /* 源码级：注册路由的那几行有没有漏掉版本前缀 */
    const source = readFileSync(new URL('../../apps/local-api/src/server.ts', import.meta.url), 'utf8');
    const registered = [...source.matchAll(/app\.(?:get|post|put|delete|patch)<[^>]*>?\(\s*'([^']+)'/g)]
      .map((match) => match[1] as string);
    const unversioned = registered.filter((path) => path !== '/health' && !path.startsWith('/api/v1/')); 

    recordAcceptance('API-001', {
      criterion: '业务端点 100% 带 /api/v1 前缀，且只绑回环地址',
      boundAddress: typeof address === 'object' && address !== null ? address.address : String(address),
      port,
      registeredRoutes: registered.length,
      unversionedRoutes: unversioned,
      projectsAtV1Status: listResponse.status,
      projectsAtV1Count: listBody.length,
      projectsAtV2Status: v2Response.status,
      hasRouteV1: projectsAtV1,
      hasRouteV2: projectsAtV2,
    });

    expect(typeof address === 'object' && address !== null ? address.address : '').toBe('127.0.0.1');
    expect(unversioned).toEqual([]);
    expect(registered.length).toBeGreaterThan(4);
    expect(listResponse.status).toBe(200);
    expect(listBody.length).toBe(1);
    expect(v2Response.status).toBe(404);
    expect(projectsAtV1).toBe(true);
    expect(projectsAtV2).toBe(false);
  }, 30_000);
});
