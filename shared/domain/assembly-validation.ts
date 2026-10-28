import type { FurnitureDoc, CompiledAssemblyIssue } from './types'
import { resolveFurnitureDimensions } from './dimensions'

export function validateFurnitureDocIssues(doc: FurnitureDoc): CompiledAssemblyIssue[] {
  return resolveFurnitureDimensions(doc).assembly.issues
}
