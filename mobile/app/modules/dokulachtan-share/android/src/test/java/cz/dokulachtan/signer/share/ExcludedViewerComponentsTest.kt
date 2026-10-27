package cz.dokulachtan.signer.share

import org.junit.Assert.assertEquals
import org.junit.Test

class ExcludedViewerComponentsTest {
  @Test
  fun excludesOwnAppAndPdfAliases() {
    assertEquals(
      listOf(
        "cz.dokulachtan.signer.MainActivity",
        "cz.dokulachtan.signer.SharePdfAlias",
        "cz.dokulachtan.signer.OpenPdfAlias"
      ),
      excludedViewerClassNames("cz.dokulachtan.signer")
    )
  }
}
