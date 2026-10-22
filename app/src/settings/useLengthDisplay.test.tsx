// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { formatLength, setLengthUnit, setPrecision } from './units'
import { useLengthDisplay } from './useLengthDisplay'

function Readout() {
  useLengthDisplay()
  return <div data-testid="r">{formatLength(1 / 3)}</div>
}

afterEach(() => {
  setPrecision(3, 'm')
  setLengthUnit('m')
})

describe('useLengthDisplay', () => {
  it('re-renders a readout when only the Precision changes', () => {
    setLengthUnit('m')
    render(<Readout />)
    expect(screen.getByTestId('r').textContent).toBe('~0.333 m')
    act(() => setPrecision(2, 'm'))
    expect(screen.getByTestId('r').textContent).toBe('~0.33 m')
  })

  it('re-renders when the format changes', () => {
    setLengthUnit('m')
    render(<Readout />)
    act(() => setLengthUnit('cm'))
    expect(screen.getByTestId('r').textContent).toBe('~33.33 cm')
  })
})
