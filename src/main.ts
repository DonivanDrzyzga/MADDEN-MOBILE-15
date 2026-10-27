import './styles.css';
import { Store } from './state/store';
import { App } from './ui/app';

let storage: Storage | null = null;
try {
  storage = window.localStorage;
} catch {
  storage = null; // private mode / blocked storage: play without saving
}

const store = new Store(storage);
new App(document.getElementById('app')!, store);
