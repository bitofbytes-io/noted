import { isDevMode } from '@angular/core';
import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/library/library.component').then((module) => module.LibraryComponent),
    title: 'Library · Noted',
  },
  {
    path: 'reader/:pieceId',
    loadComponent: () =>
      import('./features/reader/reader.component').then((module) => module.ReaderComponent),
    title: 'Score · Noted',
  },
  {
    path: 'prepare/:draftId',
    loadComponent: () =>
      import('./features/prepare/prepare.component').then((m) => m.PrepareComponent),
    title: 'Prepare score · Noted',
  },
  {
    path: 'prototype/imslp-search',
    canMatch: [() => isDevMode()],
    loadComponent: () =>
      import('./features/prepare/imslp-search.prototype').then(
        (module) => module.ImslpSearchPrototype,
      ),
    title: 'IMSLP search prototype · Noted',
  },
  { path: '**', redirectTo: '' },
];
