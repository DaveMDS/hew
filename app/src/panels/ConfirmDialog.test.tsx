import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

describe('ConfirmDialog', () => {
  const props = { heading: 'Revert to Saved?', body: 'Sure?', confirmLabel: 'Revert' }

  it('puts the keyboard on the confirm button by default', () => {
    render(<ConfirmDialog {...props} onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Revert' })).toHaveFocus()
  })

  it('puts the keyboard on Cancel when cancelDefault is set', () => {
    render(<ConfirmDialog {...props} cancelDefault onConfirm={vi.fn()} onCancel={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })

  it('confirms and cancels through its buttons', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ConfirmDialog {...props} onConfirm={onConfirm} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
