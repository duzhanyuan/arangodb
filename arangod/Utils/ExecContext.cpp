////////////////////////////////////////////////////////////////////////////////
/// DISCLAIMER
///
/// Copyright 2017 ArangoDB GmbH, Cologne, Germany
///
/// Licensed under the Apache License, Version 2.0 (the "License");
/// you may not use this file except in compliance with the License.
/// You may obtain a copy of the License at
///
///     http://www.apache.org/licenses/LICENSE-2.0
///
/// Unless required by applicable law or agreed to in writing, software
/// distributed under the License is distributed on an "AS IS" BASIS,
/// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
/// See the License for the specific language governing permissions and
/// limitations under the License.
///
/// Copyright holder is ArangoDB GmbH, Cologne, Germany
///
/// @author Manuel Baesler
////////////////////////////////////////////////////////////////////////////////

#include "ExecContext.h"

using namespace arangodb;

thread_local ExecContext* ExecContext::CURRENT_EXECCONTEXT = nullptr;

AuthLevel AuthContext::collectionAuthLevel(std::string const& collectionName) {
  for(const auto& collection : std::vector<std::string>({collectionName, "*"})) {
    auto const& it = _collectionAccess.find(collection);

    if (it == _collectionAccess.end()) {
      continue;
    }
    return it->second;
  }
  return AuthLevel::NONE;
}
