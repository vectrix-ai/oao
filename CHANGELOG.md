# Changelog

## [0.6.0](https://github.com/vectrix-ai/oao/compare/v0.5.0...v0.6.0) (2026-09-02)


### Features

* expose persistent session files ([#13](https://github.com/vectrix-ai/oao/issues/13)) ([b9092c4](https://github.com/vectrix-ai/oao/commit/b9092c4601db1c05cab0b7bda673f70ebbed40ae))

## [0.5.0](https://github.com/vectrix-ai/oao/compare/v0.4.0...v0.5.0) (2026-09-01)


### ⚠ BREAKING CHANGES

* provider credential encryption no longer binds ciphertext to a project; model, storage, sandbox, and MCP credentials stored before this release cannot be decrypted and must be rotated or re-entered. Responses for organization-shared resources no longer include projectId.

### Features

* organization-scoped projects, shared connections, and project lifecycle ([#9](https://github.com/vectrix-ai/oao/issues/9)) ([b2920d1](https://github.com/vectrix-ai/oao/commit/b2920d1708ed52bb6c4ab712ffe0a213d42436ee))

## [0.4.0](https://github.com/vectrix-ai/oao/compare/v0.3.0...v0.4.0) (2026-08-31)


### Features

* disable, enable, and remove Skills ([#7](https://github.com/vectrix-ai/oao/issues/7)) ([1bf5f47](https://github.com/vectrix-ai/oao/commit/1bf5f472daa0a2760491ab3aa7d49887b004c916))

## [0.3.0](https://github.com/vectrix-ai/oao/compare/v0.2.0...v0.3.0) (2026-08-29)


### Features

* console UX, delegate picker, and lifecycle management for agents, presets, and providers ([#5](https://github.com/vectrix-ai/oao/issues/5)) ([4390dc8](https://github.com/vectrix-ai/oao/commit/4390dc85f26ece1ee93339829fc47fb5e57b0b6c))

## [0.2.0](https://github.com/vectrix-ai/oao/compare/v0.1.0...v0.2.0) (2026-08-29)


### Features

* add community contribution files ([c2ae3a1](https://github.com/vectrix-ai/oao/commit/c2ae3a109b005d18bfbb19fac181ecb37666c872))

## 0.1.0 (2026-08-29)


### Features

* automate releases ([4de2eb2](https://github.com/vectrix-ai/oao/commit/4de2eb21fc084621532eac8c1a8c26bb9747b150))
