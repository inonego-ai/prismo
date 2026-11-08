package dev.prismo.app

import android.content.Context
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.ResponseBody
import retrofit2.Call
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query
import retrofit2.http.Streaming
import java.util.concurrent.TimeUnit

data class Health(val service: String, val status: String, val version: Int)
data class PairRequest(val code: String, val name: String, val token: String)
data class PairResponse(val paired: Boolean)
data class AppUpdate(val packageName: String, val versionCode: Long,
                     val versionName: String, val size: Long, val sha256: String)
data class AppUpdateResponse(val configured: Boolean, val update: AppUpdate?)
data class RepoSummary(val id: String, val name: String)
data class RepoList(val repositories: List<RepoSummary>)
data class Change(
    val path: String, val previousPath: String? = null,
    val stagedKind: String?, val workingKind: String?
)
data class RepoStatus(val branch: String, val head: String?, val changes: List<Change>)
data class TreeEntry(val name: String, val path: String, val directory: Boolean)
data class TreeList(val entries: List<TreeEntry>, val nextCursor: String?)
data class FileData(val path: String, val content: String?)
data class DiffData(val path: String, val diff: String)
data class Commit(val hash: String, val subject: String, val author: String, val date: String)
data class CommitList(val commits: List<Commit>, val nextCursor: String?)
data class CommitFiles(val files: List<String>, val deletedFiles: List<String>)

interface PrismoAPI {
    @GET("health") suspend fun health(): Health
    @POST("api/v1/pair") suspend fun pair(@Body request: PairRequest): PairResponse
    @GET("api/v1/app/update") suspend fun update(): AppUpdateResponse
    @Streaming
    @GET("api/v1/app/update/download") fun downloadUpdate(): Call<ResponseBody>
    @GET("api/v1/repositories") suspend fun repositories(): RepoList
    @GET("api/v1/repositories/{id}/status")
    suspend fun status(@Path("id") id: String): RepoStatus
    @GET("api/v1/repositories/{id}/tree")
    suspend fun tree(@Path("id") id: String, @Query("path") path: String,
                     @Query("cursor") cursor: String? = null): TreeList
    @GET("api/v1/repositories/{id}/file")
    suspend fun file(@Path("id") id: String, @Query("path") path: String,
                     @Query("revision") revision: String? = null): FileData
    @Streaming
    @GET("api/v1/repositories/{id}/image")
    fun image(@Path("id") id: String, @Query("path") path: String,
              @Query("revision") revision: String? = null,
              @Query("commit") commit: String? = null): Call<ResponseBody>
    @GET("api/v1/repositories/{id}/diff")
    suspend fun diff(@Path("id") id: String, @Query("scope") scope: String,
                     @Query("path") path: String, @Query("full") full: Boolean): DiffData
    @GET("api/v1/repositories/{id}/commits")
    suspend fun commits(@Path("id") id: String,
                        @Query("cursor") cursor: String? = null): CommitList
    @GET("api/v1/repositories/{id}/commits/{hash}/files")
    suspend fun commitFiles(@Path("id") id: String, @Path("hash") hash: String): CommitFiles
    @GET("api/v1/repositories/{id}/commits/{hash}/file")
    suspend fun commitFile(@Path("id") id: String, @Path("hash") hash: String,
                           @Query("path") path: String): FileData
    @GET("api/v1/repositories/{id}/commits/{hash}/diff")
    suspend fun commitDiff(@Path("id") id: String, @Path("hash") hash: String,
                           @Query("path") path: String, @Query("full") full: Boolean): DiffData
}
internal class PrismoConnection(
    api: PrismoAPI, private val transport: IrohTransport
) : PrismoAPI by api {
    // Retrofit's dynamic proxy is not reflexively equal, so the connection
    // owns the stable identity used by Compose state and effect keys.
    fun close() = transport.close()
}

internal object PrismoClient {
    fun create(context: Context, pcID: String, token: String = ""): PrismoConnection {
        val transport = IrohTransport(context.applicationContext, pcID)
        val client = OkHttpClient.Builder()
            .eventListenerFactory {
                object : EventListener() {
                    override fun canceled(call: okhttp3.Call) { transport.cancel(call) }
                }
            }
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(40, TimeUnit.SECONDS)
            .addInterceptor { chain ->
                val request = if (token.isBlank()) chain.request() else
                    chain.request().newBuilder()
                        .header("Authorization", "Bearer $token").build()
                chain.proceed(request)
            }
            .addInterceptor(transport)
            .build()
        val api = Retrofit.Builder()
            .baseUrl("https://prismo.invalid/")
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(PrismoAPI::class.java)
        return PrismoConnection(api, transport)
    }
}