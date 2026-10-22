/**
 * Every Shop sheet that declares role="dialog" also declares aria-modal, so
 * the viewport's dialog key gate (and assistive tech) treats it as blocking
 * and typed digits never reach the drawing tools behind it.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UnitPicker } from './UnitPicker'
import { ReceiveConfirmSheet } from './ReceiveConfirmSheet'
import { ViewsSheet } from './ViewsSheet'
import { RecentsSheet } from './RecentsSheet'
import { ScanSheet } from './ScanSheet'

describe('Shop sheets are modal dialogs', () => {
  it('UnitPicker', () => {
    render(<UnitPicker open orientation="portrait" onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
  })
  it('ReceiveConfirmSheet', () => {
    render(<ReceiveConfirmSheet name="Table.hew" orientation="portrait" onCancel={vi.fn()} onOpen={vi.fn()} />)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
  })
  it('ViewsSheet', () => {
    render(<ViewsSheet open orientation="portrait" onClose={vi.fn()} onSelectView={vi.fn()} projection="perspective" onToggleProjection={vi.fn()} />)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
  })
  it('RecentsSheet', () => {
    render(<RecentsSheet open orientation="portrait" entries={[]} onClose={vi.fn()} onOpen={vi.fn()} />)
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true')
  })
  it('ScanSheet', async () => {
    render(<ScanSheet open orientation="portrait" onClose={vi.fn()} onDecoded={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true'))
  })
})
