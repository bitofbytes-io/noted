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
  { path: '**', redirectTo: '' },
];
