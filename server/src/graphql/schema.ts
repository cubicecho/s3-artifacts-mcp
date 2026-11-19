import { db } from '@cubicecho/s3-artifacts-mcp-db';
import { createSchema } from './build-schema.ts';

const { schema, entities } = createSchema(db);

export { entities, schema };
