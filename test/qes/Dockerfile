# Test image pro QES RSpec harness.
#
# Vychází z produkčního DocuSeal image (Ruby 4.0.5, libpdfium.so, produkční gemy)
# a doinstaluje vývojové/testovací gemy (rspec-rails, factory_bot, capybara, ...).
# Repo forku se do kontejneru mountuje na /app (image má vlastní /app = upstream release).
#
#   podman build -t dokulachtan-qes-test -f test/qes/Dockerfile .
#
# Bez tohoto image by `bundle exec rspec` v image nešlo (BUNDLE_WITHOUT=development:test).
# Pin na 3.3.3: `latest` už má Ruby 4.0.9, ale fork (vendor/docuseal.rev) pinuje 4.0.5.
# Až se bumpne fork pin, posuň i tenhle tag.
FROM docker.io/docuseal/docuseal:3.3.3

USER root

# WORKDIR image je /data/docuseal (volume), Gemfile je v /app
WORKDIR /app
ENV BUNDLE_GEMFILE=/app/Gemfile

# build-base je potřeba pro nativní extenze dev/test gemů (pokud nějaká je)
RUN apk add --no-cache build-base git yaml-dev

# BUNDLE_WITHOUT z image přepíšeme na prázdno → doinstalují se dev/test gemy
RUN BUNDLE_WITHOUT='' bundle install --jobs 4 --retry 3
