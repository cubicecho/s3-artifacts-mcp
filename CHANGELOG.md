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
