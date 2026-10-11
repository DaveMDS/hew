import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ThickenDialog } from './ThickenDialog'
import { getThickenChoice, resetThickenChoice } from '../health/thickenSettings'

function setup(count = 3) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(<ThickenDialog count={count} onConfirm={onConfirm} onCancel={onCancel} />)
  return { onConfirm, onCancel }
}
const field = () => screen.getByRole('textbox', { name: 'Thickness' }) as HTMLInputElement

beforeEach(resetThickenChoice)

describe('ThickenDialog', () => {
  it('is named for the count and defaults to In front', () => {
    setup(3)
    expect(screen.getByRole('dialog', { name: 'Add thickness to 3 panels' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'In front' })).toBeChecked()
  })

  it('OK confirms the parsed distance (In front)', () => {
    const { onConfirm } = setup()
    fireEvent.change(field(), { target: { value: '3cm' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add thickness' }))
    expect(onConfirm).toHaveBeenCalledWith(0.03, false)
  })

  it('Behind negates; Centered sets the centered flag', () => {
    const { onConfirm } = setup()
    fireEvent.change(field(), { target: { value: '3cm' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Behind' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add thickness' }))
    expect(onConfirm).toHaveBeenLastCalledWith(-0.03, false)
    fireEvent.click(screen.getByRole('radio', { name: 'Centered' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add thickness' }))
    expect(onConfirm).toHaveBeenLastCalledWith(0.03, true)
  })

  it('rejects 0 and garbage inline without confirming', () => {
    const { onConfirm } = setup()
    for (const value of ['0', 'abc', '']) {
      fireEvent.change(field(), { target: { value } })
      fireEvent.click(screen.getByRole('button', { name: 'Add thickness' }))
      expect(screen.getByRole('alert')).toBeInTheDocument()
    }
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.change(field(), { target: { value: '1cm' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('Enter submits; Escape and Cancel cancel', () => {
    const { onConfirm, onCancel } = setup()
    fireEvent.change(field(), { target: { value: '2cm' } })
    fireEvent.submit(field().closest('form')!)
    expect(onConfirm).toHaveBeenCalledWith(0.02, false)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('remembers the last thickness and side for the session', () => {
    const { onConfirm } = setup()
    fireEvent.change(field(), { target: { value: '7mm' } })
    fireEvent.click(screen.getByRole('radio', { name: 'Centered' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add thickness' }))
    expect(onConfirm).toHaveBeenCalled()
    expect(getThickenChoice()).toEqual({ text: '7mm', side: 'centered' })
  })
})
