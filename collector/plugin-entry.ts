// Bundle entry. The opencode loader iterates Object.values(module) and rejects
// the whole module if any export is not a function (recurring pitfall #12).
// Export ONLY the plugin.
import { AgentMemoryCollector } from "./plugin"
export { AgentMemoryCollector }
export default AgentMemoryCollector
