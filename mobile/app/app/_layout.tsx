import * as Linking from 'expo-linking';
import {
  Stack,
  useRootNavigationState,
  useRouter,
} from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { useCallback, useEffect, useRef } from 'react';

import { deepLinkPath } from './+native-intent';
import { offerPdf } from '../src/lib/pdfHandoff';
import { resolveSharedPdfFile } from '../src/lib/shareIntent';

// Sdílené PDF (ACTION_SEND, share sheet „Podepsat PDF") → S14 s volbou
// „Podepsat PDF" / „Ověřit PDF". Soubor se předá interním handoffem
// (opaque id), aby ho nesežrala starší obrazovka ve stacku a cesta
// k souboru se nikdy neobjevila v URL.
function ShareIntentRoute() {
  const { shareIntent, resetShareIntent } = useShareIntentContext();
  const navigationState = useRootNavigationState();
  const router = useRouter();

  useEffect(() => {
    if (!navigationState?.key) {
      return;
    }

    let active = true;

    void resolveSharedPdfFile(shareIntent).then((file) => {
      if (!active || !file) {
        return;
      }

      router.push({
        pathname: '/verify-pdf',
        params: { handoff: offerPdf(file) },
      });
      resetShareIntent();
    });

    return () => {
      active = false;
    };
  }, [navigationState?.key, shareIntent, router, resetShareIntent]);

  return null;
}

// Deep link, který dorazí dřív než navigační ref, expo-router zahodí.
// Uložíme poslední URL a otevřeme ji, jakmile je router připravený;
// teplé odkazy už obsluhuje expo-router sám.
function DeepLinkQueue() {
  const navigationState = useRootNavigationState();
  const router = useRouter();
  const ready = Boolean(navigationState?.key);
  const readyRef = useRef(ready);
  const pending = useRef<string | null>(null);
  const handled = useRef<string | null>(null);

  const open = useCallback((url: string) => {
    const href = deepLinkPath(url);

    if (!href || href === handled.current) {
      return;
    }

    handled.current = href;

    if (readyRef.current) {
      router.dismissTo(href as never);
    } else {
      pending.current = url;
    }
  }, [router]);

  useEffect(() => {
    readyRef.current = ready;

    if (!ready || !pending.current) {
      return;
    }

    const url = pending.current;
    pending.current = null;
    open(url);
  }, [ready, open]);

  useEffect(() => {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      if (!readyRef.current) {
        open(url);
      }
    });

    return () => subscription.remove();
  }, [open]);

  // `getInitialURL()` na Androidu čte `Activity.intent`; `setIntent` v
  // MainActivity ho při novém intentu aktualizuje, takže poslední odkaz
  // neskončí na původní obrazovce.
  useEffect(() => {
    let active = true;

    void Linking.getInitialURL().then((initial) => {
      if (!active) {
        return;
      }

      if (!initial) {
        return;
      }

      const latest = Linking.getLinkingURL();

      if (!latest || latest === initial) {
        return;
      }

      open(latest);
    });

    return () => {
      active = false;
    };
  }, [open]);

  return null;
}

export default function RootLayout() {
  return (
    <ShareIntentProvider>
      <StatusBar style="auto" />
      <DeepLinkQueue />
      <Stack
        screenOptions={{
          headerTitle: 'Dokulachtan',
        }}
        screenLayout={({ children }) => (
          <>
            <ShareIntentRoute />
            {children}
          </>
        )}
      />
    </ShareIntentProvider>
  );
}
