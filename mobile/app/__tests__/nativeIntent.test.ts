import { redirectSystemPath } from '../app/+native-intent';

function server(path: string): string | null {
  const query = path.split('?')[1] ?? '';

  return new URLSearchParams(query).get('server');
}

describe('redirectSystemPath', () => {
  it('přepíše App Link /qes/sign na routu /sign a předá server z odkazu', () => {
    const path = redirectSystemPath({
      path: 'https://dokulachtan.fly.dev/qes/sign?token=abc', initial: true,
    });

    expect(path.startsWith('/sign?')).toBe(true);
    expect(new URLSearchParams(path.split('?')[1]).get('token')).toBe('abc');
    expect(server(path)).toBe('https://dokulachtan.fly.dev');
  });

  it('přepíše App Link /qes/app na routu /', () => {
    expect(
      redirectSystemPath({ path: 'https://dokulachtan.fly.dev/qes/app?token=abc', initial: false }),
    ).toBe('/?token=abc');
  });

  it('nechá custom scheme beze změny', () => {
    expect(redirectSystemPath({ path: 'dokulachtan://sign?token=abc', initial: true })).toBe(
      'dokulachtan://sign?token=abc',
    );
  });

  it('nechá ostatní odkazy beze změny', () => {
    expect(redirectSystemPath({ path: 'https://dokulachtan.fly.dev/s/abc', initial: true })).toBe(
      'https://dokulachtan.fly.dev/s/abc',
    );
  });

  it('nepřijme server z parametru, použije ověřený host App Linku', () => {
    const path = redirectSystemPath({
      path: 'https://dokulachtan.fly.dev/qes/sign?token=abc&server=https://evil.test',
      initial: true,
    });

    expect(server(path)).toBe('https://dokulachtan.fly.dev');
  });
});
