[2025-08-04 22:39:28] > offers-and-asks-slack@1.0.0 start
[2025-08-04 22:39:28] > node dist/server.js
[2025-08-04 22:39:28]
[2025-08-04 22:39:28] node:internal/modules/esm/resolve:275
[2025-08-04 22:39:28] throw new ERR_MODULE_NOT_FOUND(
[2025-08-04 22:39:28] ^
[2025-08-04 22:39:28]
[2025-08-04 22:39:28] Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/workspace/dist/lib/database' imported from /workspace/dist/app.js
[2025-08-04 22:39:28] at finalizeResolution (node:internal/modules/esm/resolve:275:11)
[2025-08-04 22:39:28] at moduleResolve (node:internal/modules/esm/resolve:860:10)
[2025-08-04 22:39:28] at defaultResolve (node:internal/modules/esm/resolve:984:11)
[2025-08-04 22:39:28] at ModuleLoader.defaultResolve (node:internal/modules/esm/loader:780:12)
[2025-08-04 22:39:28] at #cachedDefaultResolve (node:internal/modules/esm/loader:704:25)
[2025-08-04 22:39:28] at ModuleLoader.resolve (node:internal/modules/esm/loader:687:38)
[2025-08-04 22:39:28] at ModuleLoader.getModuleJobForImport (node:internal/modules/esm/loader:305:38)
[2025-08-04 22:39:28] at ModuleJob.\_link (node:internal/modules/esm/module_job:137:49) {
[2025-08-04 22:39:28] code: 'ERR_MODULE_NOT_FOUND',
[2025-08-04 22:39:28] url: 'file:///workspace/dist/lib/database'
[2025-08-04 22:39:28] }
[2025-08-04 22:39:28]
[2025-08-04 22:39:28] Node.js v22.16.0
[2025-08-04 22:39:13] ERROR failed health checks after 1 attempts with error Readiness probe failed: dial tcp 10.244.88.228:8080: i/o timeout
[2025-08-04 22:39:27] ERROR failed health checks after 6 attempts with error Readiness probe failed: dial tcp 10.244.88.228:8080: connect: connection refused
[2025-08-04 22:40:00] ERROR component terminated with non-zero exit code: 1,
