/**
 * TagsPanel — how the Tags filter interacts with expand/collapse and with a
 * reveal request (palette jump). Kept apart from scenePanels.test.tsx.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TagsPanel } from './TagsPanel'
import type { Scene as WasmScene } from '../wasm/loader'

function makeScene(tags: Record<number, string[]>): WasmScene {
  return {
    object_ids: () => new BigUint64Array(Object.keys(tags).map((k) => BigInt(k))),
    group_ids: () => new BigUint64Array(),
    instance_ids: () => new BigUint64Array(),
    node_tags: (_kind: number, id: bigint) => tags[Number(id)] ?? [],
    tag_meta_paths: () => [] as string[],
    tag_meta_hidden: () => new Uint8Array(),
  } as unknown as WasmScene
}

const baseProps = {
  docRev: 0,
  hiddenTagPaths: new Set<string>(),
  onToggleTagPath: vi.fn(),
  onDeleteTag: vi.fn(),
}

describe('TagsPanel — filter and expand/collapse', () => {
  const scene = makeScene({ 1: ['Hardware/Screws'], 2: ['Oak'] })

  it('a row the filter holds open has an inert, marked chevron: clicking it changes nothing, now or after clearing', () => {
    render(<TagsPanel {...baseProps} scene={scene} />)
    fireEvent.change(screen.getByLabelText('Filter tags'), { target: { value: 'screw' } })
    const chevron = screen.getByText('▾').closest('button') as HTMLButtonElement
    expect(chevron).toHaveAttribute('aria-disabled', 'true')
    expect(chevron.title).toBe('Held open while filtering')
    fireEvent.click(chevron)
    expect(screen.getByText('Screws')).toBeInTheDocument()
    // The click must not have collapsed the row behind the filter's back.
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }))
    expect(screen.getByText('Screws')).toBeInTheDocument()
  })

  it('without a filter the chevron collapses and re-expands as before', () => {
    render(<TagsPanel {...baseProps} scene={scene} />)
    const chevron = screen.getByText('▾').closest('button') as HTMLButtonElement
    expect(chevron).not.toHaveAttribute('aria-disabled')
    fireEvent.click(chevron)
    expect(screen.queryByText('Screws')).not.toBeInTheDocument()
  })
})

describe('TagsPanel — reveal while a filter hides the row', () => {
  const scene = makeScene({ 1: ['Hardware/Screws'], 2: ['Oak'] })

  it('clears the filter so the revealed row shows, opened and highlighted', () => {
    const { rerender } = render(<TagsPanel {...baseProps} scene={scene} />)
    fireEvent.change(screen.getByLabelText('Filter tags'), { target: { value: 'oak' } })
    expect(screen.queryByText('Screws')).not.toBeInTheDocument()
    rerender(
      <TagsPanel {...baseProps} scene={scene} revealTag={{ key: JSON.stringify(['Hardware', 'Screws']), nonce: 1 }} />,
    )
    expect((screen.getByLabelText('Filter tags') as HTMLInputElement).value).toBe('')
    const screws = screen.getByText('Screws')
    expect((screws.closest('[data-testid="tag-row"]') as HTMLElement).style.background).toContain('accent-tint-18')
  })

  it('keeps the filter when the revealed row is already shown by it', () => {
    const { rerender } = render(<TagsPanel {...baseProps} scene={scene} />)
    fireEvent.change(screen.getByLabelText('Filter tags'), { target: { value: 'oak' } })
    rerender(<TagsPanel {...baseProps} scene={scene} revealTag={{ key: JSON.stringify(['Oak']), nonce: 1 }} />)
    expect((screen.getByLabelText('Filter tags') as HTMLInputElement).value).toBe('oak')
  })

  it('typing in the filter after a reveal does not clear it again', () => {
    const { rerender } = render(<TagsPanel {...baseProps} scene={scene} />)
    rerender(<TagsPanel {...baseProps} scene={scene} revealTag={{ key: JSON.stringify(['Hardware', 'Screws']), nonce: 1 }} />)
    fireEvent.change(screen.getByLabelText('Filter tags'), { target: { value: 'oak' } })
    expect((screen.getByLabelText('Filter tags') as HTMLInputElement).value).toBe('oak')
  })
})
