import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { IsolationBar } from './IsolationBar'

describe('IsolationBar', () => {
  it('says how many objects are shown and offers Show everything', () => {
    const onShowEverything = vi.fn()
    const { rerender } = render(<IsolationBar count={1} onShowEverything={onShowEverything} />)
    expect(screen.getByText('Showing 1 object')).toBeInTheDocument()
    rerender(<IsolationBar count={6} onShowEverything={onShowEverything} />)
    expect(screen.getByText('Showing 6 objects')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show everything' }))
    expect(onShowEverything).toHaveBeenCalledTimes(1)
  })

  it('centers in the part of the viewport a right-side panel leaves free', () => {
    const { container, rerender } = render(<IsolationBar count={1} onShowEverything={() => {}} />)
    const bar = container.querySelector('[data-isolation-bar]') as HTMLElement
    expect(bar.style.left).toBe('50%')
    rerender(<IsolationBar count={1} onShowEverything={() => {}} rightInset={560} />)
    expect(bar.style.left).toMatch(/560px/)
  })

  it('sits below the camera chips (Orbit, Top, Iso, Front) that fill the top left', () => {
    const { container } = render(<IsolationBar count={1} onShowEverything={() => {}} />)
    const bar = container.querySelector('[data-isolation-bar]') as HTMLElement
    expect(parseInt(bar.style.top, 10)).toBeGreaterThanOrEqual(48)
  })
})
