# Changelog

## [0.8.0](https://github.com/vectrix-ai/oao/compare/v0.7.2...v0.8.0) (2026-10-01)


### Features

* add self-service IAP project access ([e1d41f5](https://github.com/vectrix-ai/oao/commit/e1d41f5fef87cc5b99cebf468edeab4cb5c02151))
* deliver product events to outbound webhooks ([#36](https://github.com/vectrix-ai/oao/issues/36)) ([a3df663](https://github.com/vectrix-ai/oao/commit/a3df6630f02c0d1807cf3c6c762d6c651f69b9ed))
* manage IAP project access ([5d4deb2](https://github.com/vectrix-ai/oao/commit/5d4deb231e154a701e57122cedcd9fa7c3d029dd))


### Bug Fixes

* keep mirror reruns and manual sync branches from being rewritten ([5979439](https://github.com/vectrix-ai/oao/commit/5979439ff88b8489526afb7091b2ff37265939b1))
* keep project event streams alive and share one LISTEN connection ([#35](https://github.com/vectrix-ai/oao/issues/35)) ([6fd25f3](https://github.com/vectrix-ai/oao/commit/6fd25f3a2201e5d63b55dfe3211d64ba9ee9bcfa))
* preserve IAP access invariants ([7d3a38b](https://github.com/vectrix-ai/oao/commit/7d3a38be5f3f1b3ee83a5260bdf36fb4410bf1b7))
* repair model start events that miss their dispatch correlation ([7d9e77c](https://github.com/vectrix-ai/oao/commit/7d9e77c707b9821ec13feb7206c605091331fd4e))
* retry conflicting sync pull requests when the base changes ([73996af](https://github.com/vectrix-ai/oao/commit/73996afb69636adfdbaf66627c8383c710827c1d))
* tighten IAP upgrade attribution ([acddd5f](https://github.com/vectrix-ai/oao/commit/acddd5f23432a1aa9eb6510fbc4ba45373aaf608))
* VEC-1399 manage IAP organization roles and permissions ([892de9c](https://github.com/vectrix-ai/oao/commit/892de9c61e95c8ddf7f30c297ccb05407bef71cd))
* VEC-1399 repair missing model start events ([3103ebd](https://github.com/vectrix-ai/oao/commit/3103ebdf934ea58498218b18c029910b3a5d5052))
* VEC-1399 ship the IAP migrations already deployed downstream ([7914e71](https://github.com/vectrix-ai/oao/commit/7914e71974c0f3ed820cb812f76197a638a61fee))

## [0.7.2](https://github.com/vectrix-ai/oao/compare/v0.7.1...v0.7.2) (2026-09-15)

### Bug Fixes

- activate skills for ambiguous cancellation recovery ([cb35ee1](https://github.com/vectrix-ai/oao/commit/cb35ee128f503c54057fb6fdc84774019a122517))
- allow 24-hour approval waits without consuming execution budgets ([4b43146](https://github.com/vectrix-ai/oao/commit/4b431468b9147c0ed3c665589d4917eea1181aa3))
- allow 24-hour approval waits without consuming execution budgets ([f564179](https://github.com/vectrix-ai/oao/commit/f564179f6e9b0f0c11f3e73dfe6a2acc92275bfb))
- canonicalize Skill package hashes and fail invalid startup ([c178ae0](https://github.com/vectrix-ai/oao/commit/c178ae059e75d66399a5cdf81fa2ce54ce330e1e))
- canonicalize Skill package hashes during activation ([1f5bdc5](https://github.com/vectrix-ai/oao/commit/1f5bdc5b1fdfb063df26dd976dfc429357326e87))
- preserve admitted runs during skill revocation ([d5e704e](https://github.com/vectrix-ai/oao/commit/d5e704ef7861d35a6c8d2a9826de3aff8c90c52c))
- version canonical hashes and terminalize revoked Skills ([312f222](https://github.com/vectrix-ai/oao/commit/312f222b10abf98e7a894b30f9c6f8ac8a2b4158))

## [0.7.1](https://github.com/vectrix-ai/oao/compare/v0.7.0...v0.7.1) (2026-09-09)

### Bug Fixes

- avoid per-chunk model admission transactions ([#25](https://github.com/vectrix-ai/oao/issues/25)) ([4dc3a54](https://github.com/vectrix-ai/oao/commit/4dc3a54e9a0860859e2815fdfa2dca5e445758e7))
- bound model calls and show session timing ([#24](https://github.com/vectrix-ai/oao/issues/24)) ([665ae17](https://github.com/vectrix-ai/oao/commit/665ae17f7308c35bd8d76de12c7d0cca0041b7df))
- restore Skill and delegation permissions in console ([#22](https://github.com/vectrix-ai/oao/issues/22)) ([ba6082d](https://github.com/vectrix-ai/oao/commit/ba6082d91a8bb57875f1e179c49db43a251f62ab))

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
