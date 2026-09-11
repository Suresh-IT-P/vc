'use client';

import { create } from 'zustand';

interface UiState {
  socketConnected: boolean;
  /** True when the person on the other end has their voice changer on. */
  peerVoiceEnabled: boolean;
  /** Mobile navigation drawer. */
  navOpen: boolean;
  /** In-call settings sheet. */
  voicePanelOpen: boolean;

  setSocketConnected(connected: boolean): void;
  setPeerVoiceState(enabled: boolean): void;
  setNavOpen(open: boolean): void;
  setVoicePanelOpen(open: boolean): void;
}

export const useUiStore = create<UiState>((set) => ({
  socketConnected: false,
  peerVoiceEnabled: false,
  navOpen: false,
  voicePanelOpen: false,

  setSocketConnected: (socketConnected) => set({ socketConnected }),
  setPeerVoiceState: (peerVoiceEnabled) => set({ peerVoiceEnabled }),
  setNavOpen: (navOpen) => set({ navOpen }),
  setVoicePanelOpen: (voicePanelOpen) => set({ voicePanelOpen }),
}));
