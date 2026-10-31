import { Redirect } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { consumeOpenPdf } from '../modules/dokulachtan-open-pdf';
import { offerPdf } from '../src/lib/pdfHandoff';

// Expo Router sem pošle `dokulachtan://media/...` z ACTION_VIEW; tady intent
// přečteme, zkopírujeme PDF do cache a přesměrujeme na S14 s handoffem.
// Když žádné otevřené PDF není, zobrazíme běžnou 404.
export default function NotFoundScreen() {
  const [handoff, setHandoff] = useState<string | null | undefined>(undefined);
  const consumed = useRef(false);

  useEffect(() => {
    if (consumed.current) {
      return;
    }

    consumed.current = true;
    let active = true;

    void consumeOpenPdf().then((value) => {
      if (active) {
        setHandoff(value ? offerPdf(value) : null);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  if (handoff === undefined) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (handoff) {
    return <Redirect href={{ pathname: '/verify-pdf', params: { handoff } }} />;
  }

  return (
    <View style={styles.center}>
      <Text style={styles.title}>Stránka nenalezena</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#faf7f5', padding: 24 },
  title: { fontSize: 20, fontWeight: '700' },
});
