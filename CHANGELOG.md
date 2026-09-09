# Changelog

## [0.7.1](https://github.com/vectrix-ai/oao/compare/v0.7.0...v0.7.1) (2026-09-09)


### Bug Fixes

* avoid per-chunk model admission transactions ([#25](https://github.com/vectrix-ai/oao/issues/25)) ([4dc3a54](https://github.com/vectrix-ai/oao/commit/4dc3a54e9a0860859e2815fdfa2dca5e445758e7))
* bound model calls and show session timing ([#24](https://github.com/vectrix-ai/oao/issues/24)) ([665ae17](https://github.com/vectrix-ai/oao/commit/665ae17f7308c35bd8d76de12c7d0cca0041b7df))
* restore Skill and delegation permissions in console ([#22](https://github.com/vectrix-ai/oao/issues/22)) ([ba6082d](https://github.com/vectrix-ai/oao/commit/ba6082d91a8bb57875f1e179c49db43a251f62ab))

## [0.7.0](https://github.com/vectrix-ai/oao/compare/v0.6.0...v0.7.0) (2026-09-08)

### Features

- configure model turn limits per agent ([#21](https://github.com/vectrix-ai/oao/issues/21)) ([295c2cc](https://github.com/vectrix-ai/oao/commit/295c2cc0bfccac7daad85b663bc0f106a92af4f8))
- VEC-1399 add OAO GCP dev delivery ([79bbb6b](https://github.com/vectrix-ai/oao/commit/79bbb6b675c4c77a39fc214e6ee132a969338625))

### Bug Fixes

- **auth:** support non-superuser IAP migrations ([fe566ff](https://github.com/vectrix-ai/oao/commit/fe566ff2def06cfc4bed15858c12620b67bcdd50))
- **ci:** bound runtime integration tests and preserve failures ([6beb01f](https://github.com/vectrix-ai/oao/commit/6beb01fc17d8994ecb3ba91fd8ff7a24eded9e3d))
- **db:** avoid approval deadlocks during tool publication replay ([217eacb](https://github.com/vectrix-ai/oao/commit/217eacbe7ed6c6c6584822a3b2dc0eb8ccefea55))
- discover new OpenAI models from the live catalog ([#20](https://github.com/vectrix-ai/oao/issues/20)) ([6d217bd](https://github.com/vectrix-ai/oao/commit/6d217bd908d191ef8ee04046c682a9906e336571))
- **test:** account for Flue recovery polling ([ff635e8](https://github.com/vectrix-ai/oao/commit/ff635e854f2bcadb602ea5e78db25567f823fa2c))

## [0.6.0](https://github.com/vectrix-ai/oao/compare/v0.5.0...v0.6.0) (2026-09-02)

### Features

- expose persistent session files ([#13](https://github.com/vectrix-ai/oao/issues/13)) ([b9092c4](https://github.com/vectrix-ai/oao/commit/b9092c4601db1c05cab0b7bda673f70ebbed40ae))

## [0.5.0](https://github.com/vectrix-ai/oao/compare/v0.4.0...v0.5.0) (2026-09-01)

### ⚠ BREAKING CHANGES

- provider credential encryption no longer binds ciphertext to a project; model, storage, sandbox, and MCP credentials stored before this release cannot be decrypted and must be rotated or re-entered. Responses for organization-shared resources no longer include projectId.

### Features

- organization-scoped projects, shared connections, and project lifecycle ([#9](https://github.com/vectrix-ai/oao/issues/9)) ([b2920d1](https://github.com/vectrix-ai/oao/commit/b2920d1708ed52bb6c4ab712ffe0a213d42436ee))

## [0.4.0](https://github.com/vectrix-ai/oao/compare/v0.3.0...v0.4.0) (2026-08-31)

### Features

- disable, enable, and remove Skills ([#7](https://github.com/vectrix-ai/oao/issues/7)) ([1bf5f47](https://github.com/vectrix-ai/oao/commit/1bf5f472daa0a2760491ab3aa7d49887b004c916))

## [0.3.0](https://github.com/vectrix-ai/oao/compare/v0.2.0...v0.3.0) (2026-08-29)

### Features

- console UX, delegate picker, and lifecycle management for agents, presets, and providers ([#5](https://github.com/vectrix-ai/oao/issues/5)) ([4390dc8](https://github.com/vectrix-ai/oao/commit/4390dc85f26ece1ee93339829fc47fb5e57b0b6c))

## [0.2.0](https://github.com/vectrix-ai/oao/compare/v0.1.0...v0.2.0) (2026-08-29)

### Features

- add community contribution files ([c2ae3a1](https://github.com/vectrix-ai/oao/commit/c2ae3a109b005d18bfbb19fac181ecb37666c872))

## 0.1.0 (2026-08-29)

### Features

- automate releases ([4de2eb2](https://github.com/vectrix-ai/oao/commit/4de2eb21fc084621532eac8c1a8c26bb9747b150))
