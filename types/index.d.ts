declare module 'claude-code' {
  interface PluginState {
    'file-tree': { expanded: string[]; tick: number; selected: string; cursor: string }
  }
}
