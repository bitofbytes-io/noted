import { Component, OnInit, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './core/api.service';
import { Session } from './core/models';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  protected readonly session = signal<Session | null>(null);
  protected readonly apiOffline = signal(false);

  constructor(private readonly api: ApiService) {}

  async ngOnInit(): Promise<void> {
    try {
      this.session.set(await firstValueFrom(this.api.session()));
    } catch {
      this.apiOffline.set(true);
    }
  }
}
