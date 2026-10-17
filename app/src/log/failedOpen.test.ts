import { describe, it, expect, beforeEach } from 'vitest'
import { beginOpenAttempt, clearOpenAttempt, forgetSettledFailure, getFailedOpen, openAttemptFailed } from './failedOpen'

const file = { name: 'Kitchen.skp', label: 'SketchUp model (.skp)', bytes: new Uint8Array([1, 2, 3]) }

beforeEach(() => clearOpenAttempt())

describe('failedOpen', () => {
  it('holds nothing until an attempt begins', () => {
    expect(getFailedOpen()).toBeNull()
    openAttemptFailed('no attempt to fail')
    expect(getFailedOpen()).toBeNull()
  })

  it('keeps an attempt the kernel never finished, with no error', () => {
    beginOpenAttempt(file)
    expect(getFailedOpen()).toEqual({ ...file, error: null })
  })

  it('keeps a refused attempt with its error', () => {
    beginOpenAttempt(file)
    openAttemptFailed('SKP: unsupported version')
    expect(getFailedOpen()?.error).toBe('SKP: unsupported version')
    expect(getFailedOpen()?.bytes).toBe(file.bytes)
  })

  it('drops the attempt once it lands', () => {
    beginOpenAttempt(file)
    clearOpenAttempt()
    expect(getFailedOpen()).toBeNull()
  })

  it('keeps only the latest attempt', () => {
    beginOpenAttempt(file)
    openAttemptFailed('first')
    beginOpenAttempt({ ...file, name: 'Den.skp' })
    expect(getFailedOpen()).toEqual({ ...file, name: 'Den.skp', error: null })
  })
})

describe('failedOpen: a new document', () => {
  beforeEach(() => clearOpenAttempt())

  it('forgets a failure that has settled', () => {
    beginOpenAttempt(file)
    openAttemptFailed('SKP: no')
    forgetSettledFailure()
    expect(getFailedOpen()).toBeNull()
  })

  it('keeps an attempt still under way, whose open loads a blank document of its own', () => {
    beginOpenAttempt(file)
    forgetSettledFailure()
    expect(getFailedOpen()).toEqual({ ...file, error: null })
  })
})
