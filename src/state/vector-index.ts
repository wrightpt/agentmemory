import { LocalVectorStore } from "./vector-store.js";

export { LocalVectorStore } from "./vector-store.js";
export type {
  PersistableLocalVectorStore,
  VectorDimensionValidation,
  VectorMetadata,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
} from "./vector-store.js";

/**
 * Backward-compatible name for AgentMemory's original local vector index.
 * New code should depend on VectorStore and construct LocalVectorStore.
 */
export class VectorIndex extends LocalVectorStore {
  static deserialize(json: string): VectorIndex {
    const index = new VectorIndex();
    index.loadSerialized(json);
    return index;
  }
}
