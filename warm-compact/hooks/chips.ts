import type { RenderElement, RenderNode } from 'claude-code'

// The mods that put on/off chips under the hint line share one row of them, whichever are
// loaded: each leaves its chips in a Box under this key, and the one drawn over it adds its
// own to that row instead of starting another. The same file in each such mod
export const CHIP_ROW_KEY = 'mod-chip-row'

// What the plugins beneath and the engine drew, as the rows above the chip row and the chips
// already in it: a column ending in that row, or else the drawing whole with no chips yet
export const splitChipRow = (beneath: RenderElement): { above: RenderNode[]; chips: RenderNode[] } => {
  if (beneath.type === 'Box' && beneath.props?.flexDirection === 'column') {
    const rows = beneath.children ?? []
    const last = rows.at(-1)
    if (typeof last === 'object' && last.type === 'Box' && last.props?.key === CHIP_ROW_KEY) {
      return { above: rows.slice(0, -1), chips: last.children ?? [] }
    }
  }
  return { above: [beneath], chips: [] }
}
