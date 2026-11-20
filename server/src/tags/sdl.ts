import { parse } from 'graphql';
import { TAG_DEFAULTS } from '../core/defaults.ts';

const { nameMaxLength, bulkMaxDocuments, maxTagsPerCall } = TAG_DEFAULTS;

// The hand-written half of the tags API. The `Tag` and `DocumentTag` types, the `tags` / `tag` reads,
// `Document.tags` and `Tag.documentTagsAggregate` are generated from the tables; the descriptions of their columns
// are in docs.ts.

/** The SDL `applyTagsExtension` adds to the generated schema. */
export const TAGS_SDL = parse(`
  extend type Mutation {
    """
    Makes a tag. The name is trimmed, at most ${nameMaxLength} characters, and unique to the caller ignoring case.
    \`color\` is \`#rrggbb\` (or \`#rgb\`); left out, the tag gets one picked by its name. BAD_USER_INPUT for a bad
    name or colour; CONFLICT for a name the caller already has, in any case.
    """
    createTag(name: String!, color: String): Tag!
    """
    Renames a tag, recolours it, or both. The same rules as \`createTag\`; a tag may keep its own name in a new
    case. NOT_FOUND for a tag that is missing or someone else's.
    """
    updateTag(id: UUID!, name: String, color: String): Tag!
    "Deletes a tag, which takes it off every document that has it. NOT_FOUND for a tag that is missing or someone else's."
    deleteTag(id: UUID!): Boolean!
    """
    Makes a document's tags exactly \`tagIds\`, at most ${maxTagsPerCall}; an empty list takes them all off. NOT_FOUND
    for a document or any tag that is missing or someone else's, with nothing changed.
    """
    setDocumentTags(documentId: UUID!, tagIds: [UUID!]!): Document!
    """
    Puts the \`add\` tags on every one of \`documentIds\` and takes the \`remove\` tags off, in one go: at most
    ${bulkMaxDocuments} documents and ${maxTagsPerCall} tags each way. Answers the documents. BAD_USER_INPUT for no
    documents or a tag in both lists; NOT_FOUND for any document or tag that is missing or someone else's, with nothing
    changed.
    """
    bulkTagDocuments(documentIds: [UUID!]!, add: [UUID!], remove: [UUID!]): [Document!]!
  }
`);
