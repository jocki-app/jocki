cmake_minimum_required(VERSION 3.24)
project(jocki_renames LANGUAGES C)
include(FetchContent)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(BUILD_CLI OFF CACHE BOOL "" FORCE)
set(USE_SSH OFF CACHE BOOL "" FORCE)
set(USE_HTTPS OFF CACHE BOOL "" FORCE)
set(USE_NTLMCLIENT OFF CACHE BOOL "" FORCE)
FetchContent_Declare(libgit2
  URL https://codeload.github.com/libgit2/libgit2/tar.gz/refs/tags/v1.9.7
  URL_HASH SHA256=1a4fbe7589e814777ae76b64734ad80f4ecad22cd33a22682a2aaea4ae5375e7
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
FetchContent_MakeAvailable(libgit2)
add_executable(jocki-renames main.c)
target_link_libraries(jocki-renames PRIVATE libgit2package)
target_include_directories(jocki-renames PRIVATE ${libgit2_SOURCE_DIR}/include ${libgit2_BINARY_DIR}/include)
set_target_properties(jocki-renames PROPERTIES C_STANDARD 99)
install(TARGETS jocki-renames RUNTIME DESTINATION bin)
