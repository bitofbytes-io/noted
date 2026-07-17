import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { App } from './app';
import { ApiService } from './core/api.service';
import { Session } from './core/models';

@Component({ template: '' })
class RouteFixtureComponent {}

describe('App navigation', () => {
  let sessionResponse: Session;

  beforeEach(async () => {
    sessionResponse = {
      authenticated: true,
      authMode: 'development',
      development: true,
      capabilities: { recognition: false },
      user: {
        id: 'u1',
        email: 'learner@noted.local',
        displayName: 'Local learner',
        weekStartsOn: 1,
        metronomeBpm: 96,
        metronomeAccent: true,
      },
    };
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([
          { path: 'home', component: RouteFixtureComponent },
          { path: 'player/:assetId', component: RouteFixtureComponent, data: { immersive: true } },
        ]),
        {
          provide: ApiService,
          useValue: {
            session: () => of(sessionResponse),
            logout: () => of(undefined),
          },
        },
      ],
    }).compileComponents();
  });

  it('shows Google sign-in without instantiating the application shell', async () => {
    sessionResponse = {
      authenticated: false,
      authMode: 'google',
      development: false,
      capabilities: { recognition: true },
    };
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const link = fixture.nativeElement.querySelector('a[href="/api/auth/google"]');
    expect(link).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.bottom-nav')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Continue with Google');
  });

  it('renders all five required primary destinations', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const nodes = fixture.nativeElement.querySelectorAll(
      '.bottom-nav small',
    ) as NodeListOf<Element>;
    const labels = Array.from(nodes).map((node) => node.textContent?.trim());
    expect(labels).toEqual(['Home', 'Library', 'Metronome', 'Practice', 'Settings']);
    expect(fixture.nativeElement.textContent).toContain('Local learner');
    expect(fixture.nativeElement.textContent).toContain('DEV');
  });

  it('hides the global shell only on an immersive route and restores it on exit', async () => {
    const fixture = TestBed.createComponent(App);
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/player/asset-1');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.topbar')).toBeNull();
    expect(fixture.nativeElement.querySelector('.bottom-nav')).toBeNull();
    expect(fixture.nativeElement.querySelector('.immersive-frame')).not.toBeNull();

    await router.navigateByUrl('/home');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.topbar')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.bottom-nav')).not.toBeNull();
  });
});
