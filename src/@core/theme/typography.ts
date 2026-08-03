// MUI Imports
import type { Theme } from '@mui/material/styles'

const typography = (fontFamily: string): Theme['typography'] =>
  ({
    fontFamily:
      typeof fontFamily === 'undefined' || fontFamily === ''
        ? [
            'Inter',
            'sans-serif',
            '-apple-system',
            'BlinkMacSystemFont',
            '"Segoe UI"',
            'Roboto',
            '"Helvetica Neue"',
            'Arial',
            'sans-serif',
            '"Apple Color Emoji"',
            '"Segoe UI Emoji"',
            '"Segoe UI Symbol"'
          ].join(',')
        : fontFamily,
    fontSize: 14,
    h1: {
      fontSize: '2.875rem',
      fontWeight: 500,
      lineHeight: 1.478261
    },
    h2: {
      fontSize: '2.375rem',
      fontWeight: 500,
      lineHeight: 1.47368421
    },
    h3: {
      fontSize: '1.75rem',
      fontWeight: 500,
      lineHeight: 1.5
    },
    h4: {
      fontSize: '1.5rem',
      fontWeight: 500,
      lineHeight: 1.58334
    },
    h5: {
      fontSize: '1.25rem',
      fontWeight: 650,
      lineHeight: 1.5
    },
    h6: {
      fontSize: '1rem',
      fontWeight: 600,
      lineHeight: 1.55
    },
    subtitle1: {
      fontSize: '1rem',
      fontWeight: 600,
      lineHeight: 1.55
    },
    subtitle2: {
      fontSize: '0.9rem',
      fontWeight: 500,
      lineHeight: 1.6
    },
    body1: {
      fontSize: '1rem',
      lineHeight: 1.65
    },
    body2: {
      fontSize: '0.9rem',
      lineHeight: 1.65
    },
    button: {
      fontSize: '0.9375rem',
      fontWeight: 600,
      lineHeight: 1.55,
      textTransform: 'none'
    },
    caption: {
      fontSize: '0.84rem',
      lineHeight: 1.6,
      letterSpacing: '0.1px'
    },
    overline: {
      fontSize: '0.75rem',
      lineHeight: 1.16667,
      letterSpacing: '0.8px'
    }
  }) as Theme['typography']

export default typography
