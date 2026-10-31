import { Stack, useRootNavigationState, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { useEffect } from 'react';

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

export default function RootLayout() {
  return (
    <ShareIntentProvider>
      <StatusBar style="auto" />
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
