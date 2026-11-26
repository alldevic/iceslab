import { Component, type ReactNode } from 'react';
import { setCaught } from '@/test/screens';

/** Catches what a screen throws while rendering and remembers it in `screens.caught`. */
export class Boundary extends Component<{ children: ReactNode }> {
  componentDidCatch(err: Error) {
    setCaught(err);
  }
  render() {
    return this.props.children;
  }
}
