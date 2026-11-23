package app.jocki;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.system.Os;
import android.system.OsConstants;
import android.util.AtomicFile;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** Selected SAF trees are capabilities; the AndroidX library owns URI traversal. */
@CapacitorPlugin(name="VaultFiles")
public class VaultFilesPlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private JSONObject catalog;
    private File base() { return new File(getContext().getFilesDir(), "file-workspaces"); }
    private interface Operation { JSObject run() throws Exception; }
    private void perform(PluginCall call, Operation operation) {
        io.execute(() -> { try { loadCatalog(); recover(); call.resolve(operation.run()); } catch (Exception error) { call.reject(error.getMessage(), error); } });
    }
    private static byte[] read(InputStream input) throws IOException {
        try (InputStream stream = input; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[16384]; int count;
            while ((count = stream.read(buffer)) != -1) { if (out.size() + count > 256 * 1024 * 1024) throw new IOException("File exceeds 256 MB mobile limit"); out.write(buffer, 0, count); }
            return out.toByteArray();
        }
    }
    private byte[] readRange(InputStream input, PluginCall call) throws Exception {
        JSONArray range = new JSONArray(new String(Base64.decode(call.getString("data", ""), Base64.DEFAULT), StandardCharsets.UTF_8));
        long offset = range.getLong(0); int length = range.getInt(1);
        if (offset < 0 || length < 0 || length > 1024 * 1024) throw new IOException("Invalid read range");
        try (InputStream stream = input; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            while (offset > 0) { long skipped = stream.skip(offset); if (skipped == 0) { if (stream.read() == -1) return new byte[0]; skipped = 1; } offset -= skipped; }
            byte[] buffer = new byte[Math.min(65536, length)];
            while (output.size() < length) { int count = stream.read(buffer, 0, Math.min(buffer.length, length - output.size())); if (count == -1) break; output.write(buffer, 0, count); }
            return output.toByteArray();
        }
    }
    private static void syncDirectory(File directory) throws Exception {
        FileDescriptor descriptor = Os.open(directory.getPath(), OsConstants.O_RDONLY, 0);
        try { Os.fsync(descriptor); } finally { Os.close(descriptor); }
    }
    private static void atomic(File file, byte[] bytes) throws Exception {
        File parent = file.getParentFile(); if (!parent.isDirectory() && !parent.mkdirs()) throw new IOException("Cannot create directory");
        AtomicFile disk = new AtomicFile(file); FileOutputStream stream = disk.startWrite();
        try { stream.write(bytes); stream.flush(); stream.getFD().sync(); disk.finishWrite(stream); syncDirectory(parent); }
        catch (Exception error) { disk.failWrite(stream); throw error; }
    }
    private void loadCatalog() throws Exception {
        if (catalog != null) return;
        File file = new File(base(), "capabilities.json");
        if (file.exists()) catalog = new JSONObject(new String(read(new AtomicFile(file).openRead()), StandardCharsets.UTF_8));
        else { catalog = new JSONObject().put("computer", UUID.randomUUID().toString()).put("roots", new JSONObject()); persistCatalog(); }
    }
    private void persistCatalog() throws Exception { atomic(new File(base(), "capabilities.json"), catalog.toString().getBytes(StandardCharsets.UTF_8)); }
    @PluginMethod public void workspace(PluginCall call) { perform(call, () -> {
        JSObject result = new JSObject(); result.put("computer", catalog.getString("computer")); result.put("sandboxedExtensions", WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) && !getBridge().getConfig().isUsingLegacyBridge()); return result;
    }); }
    @PluginMethod public void roots(PluginCall call) { perform(call, () -> {
        JSArray roots = new JSArray(); JSONObject values = catalog.getJSONObject("roots");
        for (Iterator<String> keys = values.keys(); keys.hasNext();) { String key = keys.next(); roots.put(new JSONObject().put("token", key).put("name", values.getJSONObject(key).getString("name"))); }
        JSObject result = new JSObject(); result.put("roots", roots); return result;
    }); }
    @PluginMethod public void select(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "selected");
    }
    @ActivityCallback private void selected(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { JSObject cancelled = new JSObject(); cancelled.put("cancelled", true); call.resolve(cancelled); return; }
        Uri uri = result.getData().getData();
        getContext().getContentResolver().takePersistableUriPermission(uri, result.getData().getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION));
        perform(call, () -> {
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), uri); if (root == null || !root.canWrite()) throw new IOException("Folder needs write access");
            JSONObject values = catalog.getJSONObject("roots"); String token = UUID.randomUUID().toString();
            for (Iterator<String> keys = values.keys(); keys.hasNext();) { String key = keys.next(); if (values.getJSONObject(key).getString("uri").equals(uri.toString())) token = key; }
            String parentFor = call.getString("parentFor");
            if (parentFor != null) {
                JSONObject selected = values.getJSONObject(parentFor); DocumentFile child = root.findFile(selected.getString("name"));
                if (child == null || !android.provider.DocumentsContract.getDocumentId(child.getUri()).equals(android.provider.DocumentsContract.getTreeDocumentId(Uri.parse(selected.getString("uri"))))) throw new IOException("Select the direct parent of " + selected.getString("name"));
                selected.put("parentUri", uri.toString()); persistCatalog();
                JSObject answer = new JSObject(); answer.put("token", parentFor); answer.put("name", selected.getString("name")); return answer;
            }
            values.put(token, new JSONObject().put("name", root.getName()).put("uri", uri.toString())); persistCatalog();
            JSObject answer = new JSObject(); answer.put("token", token); answer.put("name", root.getName()); return answer;
        });
    }
    private static String[] parts(String path) throws IOException {
        if (path == null || path.isEmpty() || path.contains("\\") || path.contains(":")) throw new IOException("Invalid relative path");
        for (int i = 0; i < path.length(); i++) if (path.charAt(i) < 32) throw new IOException("Invalid relative path");
        String[] parts = path.split("/", -1); for (String part : parts) if (part.isEmpty() || part.equals(".") || part.equals("..")) throw new IOException("Invalid relative path"); return parts;
    }
    private DocumentFile root(String token) throws Exception {
        JSONObject roots = catalog.getJSONObject("roots"); if (!roots.has(token)) throw new IOException("Select this folder locally first");
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(roots.getJSONObject(token).getString("uri")));
        if (root == null || !root.exists()) throw new IOException("Folder is unavailable"); return root;
    }
    private DocumentFile parent(DocumentFile root, String[] parts, boolean create) throws IOException {
        DocumentFile current = root;
        for (int i = 0; i < parts.length - 1; i++) { DocumentFile next = current.findFile(parts[i]); if (next == null && create) next = current.createDirectory(parts[i]); if (next == null) return null; if (!next.isDirectory()) throw new IOException("Path is not a directory"); current = next; }
        return current;
    }
    private File local(String path, boolean create) throws Exception {
        String[] names = parts(path); File root = new File(base(), "workspace").getCanonicalFile(); if (!root.isDirectory() && !root.mkdirs()) throw new IOException("Cannot create workspace"); File current = root;
        for (int i = 0; i < names.length; i++) { File next = new File(current, names[i]); if (!next.getCanonicalFile().equals(next.getAbsoluteFile())) throw new IOException("Vault symlinks are not followed"); if (create && i < names.length - 1 && !next.isDirectory() && !next.mkdir()) throw new IOException("Cannot create directory"); current = next; } return current;
    }
    private static boolean hidden(String name) { return name.equalsIgnoreCase(".saddle") || name.startsWith(".jocki-write-") || name.startsWith(".jocki-old-"); }
    private void list(DocumentFile directory, String prefix, JSArray paths, int depth) throws IOException {
        if (depth > 64) throw new IOException("Folder depth exceeds limit");
        for (DocumentFile file : directory.listFiles()) { String name = file.getName(); if (name == null || hidden(name)) continue; if (file.isDirectory() && name.endsWith(".saddle")) paths.put(prefix + name); else if (file.isDirectory()) list(file, prefix + name + "/", paths, depth + 1); else if (file.isFile()) paths.put(prefix + name); }
    }
    private void list(File directory, String prefix, JSArray paths, int depth) throws Exception {
        if (depth > 64) throw new IOException("Folder depth exceeds limit"); File[] files = directory.listFiles(); if (files == null) return;
        for (File file : files) { if (hidden(file.getName()) || !file.getCanonicalFile().equals(file.getAbsoluteFile())) continue; if (file.isDirectory() && file.getName().endsWith(".saddle")) paths.put(prefix + file.getName()); else if (file.isDirectory()) list(file, prefix + file.getName() + "/", paths, depth + 1); else if (file.isFile()) paths.put(prefix + file.getName()); }
    }
    private void directories(DocumentFile directory, String prefix, JSArray paths, int depth) throws IOException {
        if (depth > 64) throw new IOException("Folder depth exceeds limit");
        for (DocumentFile file : directory.listFiles()) { String name = file.getName(); if (name != null && !hidden(name) && !name.endsWith(".saddle") && file.isDirectory()) { paths.put(prefix + name); directories(file, prefix + name + "/", paths, depth + 1); } }
    }
    private void directories(File directory, String prefix, JSArray paths, int depth) throws Exception {
        if (depth > 64) throw new IOException("Folder depth exceeds limit"); File[] entries = directory.listFiles(); if(entries == null)return;
        for(File file:entries) if(!hidden(file.getName()) && !file.getName().endsWith(".saddle") && file.getCanonicalFile().equals(file.getAbsoluteFile()) && file.isDirectory()) { paths.put(prefix + file.getName()); directories(file,prefix+file.getName()+"/",paths,depth+1); }
    }
    private void removeEmpty(DocumentFile directory) throws IOException { if(!directory.isDirectory())throw new IOException("Expected folder"); for(DocumentFile child:directory.listFiles()) {if(!child.isDirectory())throw new IOException("Folder contains files; rescan before deleting");removeEmpty(child);}if(!directory.delete())throw new IOException("Cannot remove folder"); }
    private void removeEmpty(File directory) throws Exception { File[] entries=directory.listFiles(); if(entries==null)throw new IOException("Expected folder");for(File child:entries){if(!child.isDirectory())throw new IOException("Folder contains files; rescan before deleting");removeEmpty(child);}if(!directory.delete())throw new IOException("Cannot remove folder");syncDirectory(directory.getParentFile()); }
    private void removeMetadata(File file) throws Exception {
        if (!file.exists()) return;
        if (!file.getCanonicalFile().equals(file.getAbsoluteFile())) throw new IOException("Vault symlinks are not followed");
        if (file.isDirectory()) { File[] children = file.listFiles(); if (children == null) throw new IOException("Cannot list metadata"); for (File child : children) removeMetadata(child); }
        if (!file.delete()) throw new IOException("Cannot delete metadata");
    }
    // SAF does not expose replace-rename. Journal the replacement before moving
    // either name, and roll an interrupted operation back before any core read.
    private void recover() throws Exception {
        File journal = new File(base(), "replacement.json"); if (!journal.exists()) return;
        JSONObject entry = new JSONObject(new String(read(new AtomicFile(journal).openRead()), StandardCharsets.UTF_8));
        DocumentFile directory = entry.getBoolean("companion") ? companionParent(entry.getString("token")) : parent(root(entry.getString("token")), parts(entry.getString("path")), false);
        if (directory == null) throw new IOException("Cannot recover folder replacement");
        DocumentFile target = directory.findFile(entry.getString("name")), backup = directory.findFile(entry.getString("backup")), temporary = directory.findFile(entry.getString("temporary"));
        if (backup == null) for (DocumentFile candidate : directory.listFiles()) if (candidate.getName() != null && candidate.getName().startsWith(entry.getString("backup"))) { backup = candidate; break; }
        if (target == null && backup != null && !backup.renameTo(entry.getString("name"))) throw new IOException("Cannot recover previous file");
        if (target != null && backup != null && !backup.delete()) throw new IOException("Cannot remove replacement backup");
        if (temporary != null && !temporary.delete()) throw new IOException("Cannot remove incomplete replacement");
        if (!journal.delete()) throw new IOException("Cannot complete recovery"); syncDirectory(base());
    }
    private void replace(String token, String path, DocumentFile parent, String name, byte[] bytes, boolean companion) throws Exception {
        String suffix = UUID.randomUUID().toString(), temporaryName = ".jocki-write-" + suffix, backupName = ".jocki-old-" + suffix;
        DocumentFile temporary = parent.createFile("application/octet-stream", temporaryName); if (temporary == null) throw new IOException("Provider cannot create files");
        try (ParcelFileDescriptor descriptor = getContext().getContentResolver().openFileDescriptor(temporary.getUri(), "rwt")) {
            if (descriptor == null) throw new IOException("Provider cannot open file");
            try (ParcelFileDescriptor.AutoCloseOutputStream stream = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor)) { stream.write(bytes); stream.flush(); stream.getFD().sync(); }
        } catch (Exception error) { temporary.delete(); throw new IOException("Folder provider cannot flush a durable write", error); }
        atomic(new File(base(), "replacement.json"), new JSONObject().put("token", token).put("path", path).put("companion", companion).put("name", name).put("temporary", temporary.getName()).put("backup", backupName).toString().getBytes(StandardCharsets.UTF_8));
        DocumentFile old = parent.findFile(name);
        if (old != null && !old.renameTo(backupName)) throw new IOException("Provider cannot rename files");
        if (!temporary.renameTo(name)) throw new IOException("Provider cannot publish file");
        if (old != null && !old.delete()) throw new IOException("Provider cannot remove replacement backup");
        if (!new File(base(), "replacement.json").delete()) throw new IOException("Cannot complete replacement"); syncDirectory(base());
    }
    private JSONObject info(File file, String path) throws Exception {
        return new JSONObject().put("path", path).put("kind", file.getName().endsWith(".saddle") ? "companion" : file.isDirectory() ? "folder" : "file").put("size", file.length()).put("stamp", file.length() + ":" + file.lastModified());
    }
    private JSONObject info(DocumentFile file, String path) throws Exception {
        return new JSONObject().put("path", path).put("kind", file.getName() != null && file.getName().endsWith(".saddle") ? "companion" : file.isDirectory() ? "folder" : "file").put("size", file.length()).put("stamp", file.getUri() + ":" + file.length() + ":" + file.lastModified());
    }
    private void scan(File root, String prefix, JSArray result) throws Exception {
        ArrayDeque<File> pending = new ArrayDeque<>(); ArrayDeque<String> prefixes = new ArrayDeque<>(); pending.push(root); prefixes.push(prefix);
        while (!pending.isEmpty()) { File dir = pending.pop(); String basePath = prefixes.pop(); File[] entries = dir.listFiles(); if (entries == null) continue;
            for (File file : entries) { if (hidden(file.getName()) || file.getName().equals(".git") || !file.getCanonicalFile().equals(file.getAbsoluteFile())) continue; String path = basePath + file.getName(); result.put(info(file, path)); if (file.isDirectory() && !file.getName().endsWith(".saddle")) { pending.push(file); prefixes.push(path + "/"); } }
        }
    }
    private void scan(DocumentFile root, String prefix, JSArray result) throws Exception {
        ArrayDeque<DocumentFile> pending = new ArrayDeque<>(); ArrayDeque<String> prefixes = new ArrayDeque<>(); Set<String> visited = new HashSet<>(); pending.push(root); prefixes.push(prefix);
        while (!pending.isEmpty()) { DocumentFile dir = pending.pop(); String basePath = prefixes.pop(); if (!visited.add(dir.getUri().toString())) continue;
            for (DocumentFile file : dir.listFiles()) { String name = file.getName(); if (name == null || hidden(name) || name.equals(".git")) continue; String path = basePath + name; result.put(info(file, path)); if (file.isDirectory() && !name.endsWith(".saddle")) { pending.push(file); prefixes.push(path + "/"); } }
        }
    }
    private DocumentFile companionParent(String token) throws Exception {
        String uri = catalog.getJSONObject("roots").getJSONObject(token).optString("parentUri", "");
        return uri.isEmpty() ? null : DocumentFile.fromTreeUri(getContext(), Uri.parse(uri));
    }
    private void copy(DocumentFile source, DocumentFile destination, String name) throws Exception {
        if (source.isDirectory()) { DocumentFile child = destination.createDirectory(name); if (child == null) throw new IOException("Cannot create move destination"); for (DocumentFile file : source.listFiles()) copy(file, child, file.getName()); }
        else { DocumentFile child = destination.createFile("application/octet-stream", name); if (child == null) throw new IOException("Cannot create move destination");
            try (InputStream input = getContext().getContentResolver().openInputStream(source.getUri()); ParcelFileDescriptor descriptor = getContext().getContentResolver().openFileDescriptor(child.getUri(), "rwt")) {
                if (input == null || descriptor == null) throw new IOException("Cannot open move destination");
                try (ParcelFileDescriptor.AutoCloseOutputStream output = new ParcelFileDescriptor.AutoCloseOutputStream(descriptor)) { byte[] buffer = new byte[65536]; int count; while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count); output.flush(); output.getFD().sync(); }
            }
        }
    }
    @PluginMethod public void files(PluginCall call) { perform(call, () -> {
        String token = call.getString("token"), operation = call.getString("operation"), path = call.getString("path"); JSObject answer = new JSObject();
        if ("workspace".equals(token)) {
            if ("root-access".equals(operation)) { answer.put("value", true); return answer; }
            if ("scan".equals(operation)) { JSArray entries = new JSArray(); String prefix = path == null || path.isEmpty() ? "" : path.replaceAll("/+$", ""); File directory = prefix.isEmpty() ? new File(base(), "workspace") : local(prefix, false); scan(directory, prefix.isEmpty() ? "" : prefix + "/", entries); answer.put("value", entries); return answer; }
            if ("stat".equals(operation)) { File file = local(path, false); answer.put("value", file.exists() ? info(file, path) : JSONObject.NULL); return answer; }
            if ("move".equals(operation)) { File source = local(path, false), destination = local(new String(Base64.decode(call.getString("data", ""), Base64.DEFAULT), StandardCharsets.UTF_8), true); if (destination.exists() || !source.renameTo(destination)) throw new IOException("Cannot move to an occupied destination"); syncDirectory(source.getParentFile()); syncDirectory(destination.getParentFile()); return answer; }
            if ("list".equals(operation)) { JSArray paths = new JSArray(); File directory = new File(base(), "workspace"); list(directory, "", paths, 0); answer.put("paths", paths); return answer; }
            if ("directories".equals(operation)) { JSArray paths = new JSArray(); directories(new File(base(), "workspace"), "", paths, 0); answer.put("paths", paths); return answer; }
            File file = local(path, "write".equals(operation) || "mkdir".equals(operation));
            if ("mkdir".equals(operation)) { if (!file.isDirectory() && !file.mkdir()) throw new IOException("Cannot create folder"); syncDirectory(file.getParentFile()); }
            else if ("reset".equals(operation)) { if (!file.getName().endsWith(".saddle")) throw new IOException("Only Jocki metadata can be deleted recursively"); removeMetadata(file); if (file.getParentFile().isDirectory()) syncDirectory(file.getParentFile()); }
            else if ("rmdir".equals(operation)) removeEmpty(file);
            else if ("read".equals(operation)) answer.put("data", file.exists() ? Base64.encodeToString(read(new AtomicFile(file).openRead()), Base64.NO_WRAP) : JSONObject.NULL);
            else if ("read-range".equals(operation)) answer.put("data", file.exists() ? Base64.encodeToString(readRange(new FileInputStream(file), call), Base64.NO_WRAP) : JSONObject.NULL);
            else if ("write".equals(operation)) atomic(file, Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            else if ("remove".equals(operation)) { if (file.exists() && !file.delete()) throw new IOException("Cannot remove file"); if (file.getParentFile().isDirectory()) syncDirectory(file.getParentFile()); }
            else throw new IOException("Invalid file operation"); return answer;
        }
        DocumentFile root = root(token);
        if ("root-access".equals(operation)) { DocumentFile parent = companionParent(token); answer.put("value", parent != null && parent.canWrite()); return answer; }
        if ("delete-root-companion".equals(operation)) { DocumentFile parent = companionParent(token); if (parent == null) throw new IOException("Grant access to the parent folder"); DocumentFile packageFolder = parent.findFile("." + root.getName() + ".saddle"); if (packageFolder != null && !packageFolder.delete()) throw new IOException("Cannot delete companion"); return answer; }
        if (operation != null && operation.startsWith("root-")) {
            DocumentFile directory = companionParent(token); operation = operation.substring(5);
            if (!"container".equals(path) || !Arrays.asList("read", "read-range", "write", "remove", "stat").contains(operation)) throw new IOException("Invalid unit-container capability path");
            if (directory == null) { if ("read".equals(operation) || "read-range".equals(operation)) { answer.put("data", JSONObject.NULL); return answer; } throw new IOException("Grant access to the parent folder"); }
            String name = "." + root.getName() + ".saddle"; DocumentFile file = directory.findFile(name);
            if (file != null && !file.isFile()) throw new IOException("Unit container must be a file");
            if ("read".equals(operation)) answer.put("data", file == null ? JSONObject.NULL : Base64.encodeToString(read(getContext().getContentResolver().openInputStream(file.getUri())), Base64.NO_WRAP));
            else if ("read-range".equals(operation)) answer.put("data", file == null ? JSONObject.NULL : Base64.encodeToString(readRange(getContext().getContentResolver().openInputStream(file.getUri()), call), Base64.NO_WRAP));
            else if ("write".equals(operation)) replace(token, path, directory, name, Base64.decode(call.getString("data", ""), Base64.DEFAULT), true);
            else if ("remove".equals(operation)) { if (file != null && !file.delete()) throw new IOException("Cannot delete unit container"); }
            else if ("stat".equals(operation)) answer.put("value", file == null ? JSONObject.NULL : info(file, path));
            return answer;
        }

        if ("scan".equals(operation)) { JSArray entries = new JSArray(); String prefix = path == null || path.isEmpty() ? "" : path.replaceAll("/+$", ""); DocumentFile dir = root; if (!prefix.isEmpty()) { String[] names = parts(prefix + "/_"); dir = parent(root, names, false); } if (dir != null) scan(dir, prefix.isEmpty() ? "" : prefix + "/", entries); answer.put("value", entries); return answer; }
        if ("stat".equals(operation)) { String[] names = parts(path); DocumentFile directory = parent(root, names, false), file = directory == null ? null : directory.findFile(names[names.length - 1]); answer.put("value", file == null ? JSONObject.NULL : info(file, path)); return answer; }
        if ("move".equals(operation)) { String[] sourceNames = parts(path), targetNames = parts(new String(Base64.decode(call.getString("data", ""), Base64.DEFAULT), StandardCharsets.UTF_8)); DocumentFile sourceParent = parent(root, sourceNames, false), destination = parent(root, targetNames, true), source = sourceParent == null ? null : sourceParent.findFile(sourceNames[sourceNames.length - 1]); String name = targetNames[targetNames.length - 1]; if (source == null || destination == null || destination.findFile(name) != null) throw new IOException("Cannot move to an occupied destination"); String temporary = ".jocki-write-" + UUID.randomUUID(); copy(source, destination, temporary); DocumentFile ready = destination.findFile(temporary); if (ready == null || !ready.renameTo(name)) throw new IOException("Cannot publish move"); if (!source.delete()) throw new IOException("Cannot complete move"); return answer; }
        if ("list".equals(operation)) { JSArray paths = new JSArray(); list(root, "", paths, 0); answer.put("paths", paths); return answer; }
        if ("directories".equals(operation)) { JSArray paths = new JSArray(); directories(root, "", paths, 0); answer.put("paths", paths); return answer; }
        String[] names = parts(path); String name = names[names.length - 1]; DocumentFile directory = parent(root, names, "write".equals(operation) || "mkdir".equals(operation)), file = directory == null ? null : directory.findFile(name);
        if ("mkdir".equals(operation)) { if(directory == null || (file == null && directory.createDirectory(name) == null) || (file != null && !file.isDirectory())) throw new IOException("Cannot create folder"); }
        else if ("reset".equals(operation)) { if (!name.endsWith(".saddle")) throw new IOException("Only Jocki metadata can be deleted recursively"); if (file != null && !file.delete()) throw new IOException("Cannot delete metadata"); }
        else if ("rmdir".equals(operation)) { if(file != null)removeEmpty(file); }
        else if ("read".equals(operation)) answer.put("data", file == null ? JSONObject.NULL : Base64.encodeToString(read(getContext().getContentResolver().openInputStream(file.getUri())), Base64.NO_WRAP));
        else if ("read-range".equals(operation)) answer.put("data", file == null ? JSONObject.NULL : Base64.encodeToString(readRange(getContext().getContentResolver().openInputStream(file.getUri()), call), Base64.NO_WRAP));
        else if ("write".equals(operation)) { if (directory == null) throw new IOException("Missing parent folder"); replace(token, path, directory, name, Base64.decode(call.getString("data", ""), Base64.DEFAULT), false); }
        else if ("remove".equals(operation)) { if (file != null && !file.delete()) throw new IOException("Cannot remove file"); }
        else throw new IOException("Invalid file operation"); return answer;
    }); }
}
