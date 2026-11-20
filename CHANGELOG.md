# [1.5.0](https://github.com/cubicecho/s3-artifacts-mcp/compare/v1.4.0...v1.5.0) (2026-11-20)

### Bug Fixes

* **docker:** leave the dev tools out of the runtime image ([933e24a](https://github.com/cubicecho/s3-artifacts-mcp/commit/933e24a90a5bb19d647d4c9156fd61eecf561e71))

### Features

* **compose:** pin the quickstart's image and name its address behind a proxy ([a0a2741](https://github.com/cubicecho/s3-artifacts-mcp/commit/a0a2741b5cb7b98f098bc13411406b6a797907bf))

# [1.4.0](https://github.com/cubicecho/s3-artifacts-mcp/compare/v1.3.0...v1.4.0) (2026-11-20)

### Bug Fixes

* **mcp:** list_tags names no tag used only in another bucket ([cb338b6](https://github.com/cubicecho/s3-artifacts-mcp/commit/cb338b60cc43495a8167668eb0f3f100f8664c59))
* **mcp:** name list_tags in a read-only bucket's instructions ([de786e3](https://github.com/cubicecho/s3-artifacts-mcp/commit/de786e3e46bb0ec5167946b95300a6531d88945b))

### Features

* **app:** tags in the documents list, its filters, and tagging in bulk ([e4baf3c](https://github.com/cubicecho/s3-artifacts-mcp/commit/e4baf3cf726ab531d4d1f62ad586ad64b4f7f1c0))
* **app:** the Tags page, and a tag picker on the document page ([838044b](https://github.com/cubicecho/s3-artifacts-mcp/commit/838044b5c083c828ffe59419b16b96730e2b0b1c))
* **mcp:** list_tags, tag_document, and tags on the upload tools ([a264e7b](https://github.com/cubicecho/s3-artifacts-mcp/commit/a264e7b70c0df8486cec893908cb51f0f21458fd))
* **server:** the owner's tags, and tagging documents ([c9e190f](https://github.com/cubicecho/s3-artifacts-mcp/commit/c9e190f71a7c7ecdfef6d4f2a44f2fb4747cf9e7))

# [1.3.0](https://github.com/cubicecho/s3-artifacts-mcp/compare/v1.2.0...v1.3.0) (2026-11-20)

### Features

* **app:** Settings → MCP, per bucket ([29beafc](https://github.com/cubicecho/s3-artifacts-mcp/commit/29beafc8133d85881d37f0a8e5790cf7f433c503))
* **server:** an MCP endpoint per bucket ([481b084](https://github.com/cubicecho/s3-artifacts-mcp/commit/481b084ff059353c8ca63bc71a606df0f78e1b91))

# [1.2.0](https://github.com/cubicecho/s3-artifacts-mcp/compare/v1.1.0...v1.2.0) (2026-11-20)

### Bug Fixes

* **server:** undo a re-key whose old object the bucket will not delete ([505205a](https://github.com/cubicecho/s3-artifacts-mcp/commit/505205acd65298fc414b9d3ee3f8419fe43feb65))

### Features

* **app:** share links, their lists, and Settings → General ([d09b12f](https://github.com/cubicecho/s3-artifacts-mcp/commit/d09b12f4f1a5762e20928d8b2b93293d31e39e17))
* **server:** share links, re-keying and app settings ([021adec](https://github.com/cubicecho/s3-artifacts-mcp/commit/021adec850e062d75c6986160ee288d41196b8cc))

# [1.1.0](https://github.com/cubicecho/s3-artifacts-mcp/compare/v1.0.0...v1.1.0) (2026-11-20)

### Features

* add buckets on any S3-compatible provider, managed in settings ([5d75d73](https://github.com/cubicecho/s3-artifacts-mcp/commit/5d75d7363da75858e9e12410744bb1bea71c6273))
* **app:** re-enter a bucket's secret on its own, through setBucketSecret ([136825a](https://github.com/cubicecho/s3-artifacts-mcp/commit/136825a9bce38132213dc7261d84380af803dd37))
* **app:** scan buckets from settings and the documents page ([3b1cffc](https://github.com/cubicecho/s3-artifacts-mcp/commit/3b1cffc4cafe7f619dd2c883e133e566f37312dc))
* **app:** upload, browse and preview documents ([d9bcee1](https://github.com/cubicecho/s3-artifacts-mcp/commit/d9bcee1ec6e37939d390ce62dbe1dbf26715fb3e))
* drop the default bucket ([23e4136](https://github.com/cubicecho/s3-artifacts-mcp/commit/23e4136ae08f3e47289b2362aad96e216919aebd))
* **server:** scan a bucket for the files already in it ([dbf635f](https://github.com/cubicecho/s3-artifacts-mcp/commit/dbf635f68c8c3b9d6bd80f74297403d149bc0811))
* **server:** store documents in buckets, streamed through the server ([42e9331](https://github.com/cubicecho/s3-artifacts-mcp/commit/42e93319c3d4815727fa55b55ff67c7529eff3fa))

# 1.0.0 (2026-11-20)

### Features

* scaffold from engrafo with sign-in, sso pairing and api keys ([af71628](https://github.com/cubicecho/s3-artifacts-mcp/commit/af716280b1195bb8ef878203765a57344c7b4b94))
